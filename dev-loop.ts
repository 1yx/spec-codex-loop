/**
 * dev-loop — autonomous spec-driven PR loop driven by OpenSpec changes listed in
 * TODO.md, each developed in its own git worktree, gated by Codex review.
 *
 * Flow per change:
 *   TODO.md `- [ ] <change>`  →  worktree .worktree/<change> on branch <change>
 *   →  openspec-apply-change (implement tasks) → commit → push → gh pr create
 *   →  @codex review → fix per suggestions → push  (repeat until Codex passes / repeats)
 *   →  openspec archive → merge --squash → mark `- [x]` → remove worktree
 *
 * Outside the loop: create the OpenSpec change (e.g. via the explore / grill-me
 * skills), then add its name as a `- [ ] <change>` line in TODO.md. The change
 * must exist under openspec/changes/ in this repo (committed or not — if it isn't
 * on origin/main yet, it is copied into the worktree and committed there).
 *
 * Usage (inside pi):
 *   /loop                 run the next TODO change end-to-end, then stop
 *   /loop <change>        run a specific change (added to TODO.md if absent)
 *   /loop --dry-run       build phase only; skip push/PR/review/archive/merge
 *   /loop --all           keep pulling changes from TODO.md until none left
 *
 * The OUTER loop is deterministic TS (can't drift). The fuzzy work (implement,
 * address review) is delegated to pi's agent, one bounded turn at a time, each
 * told to work inside the change's worktree.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_LOGIN = "chatgpt-codex-connector"; // bot login prefix; API may append "[bot]"
const PASS_RE = /Didn't find any major issues/i;
// Quota-exhausted: posted instead of a review when the account's code-review
// budget is spent (resets on its own, usually within a day). Verified phrasings:
//   "You have reached your Codex usage limits for code reviews."
//   "Code review usage limits reached"
const QUOTA_RE = /usage limits? for code reviews|code review usage limits? reached/i;
const REVIEW_WAIT_MS = 10 * 60_000; // poll interval between Codex fetches
const REVIEW_TOTAL_TIMEOUT_MS = 30 * 60_000; // cap per round (~3 intervals); raise to be more patient
const WORKTREE_ROOT = ".worktree";

interface Suggestion {
  severity: string | null;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}
interface PollResult {
  pass: boolean;
  timeout: boolean;
  stopped: boolean;
  quotaExhausted: boolean;
  suggestions: Suggestion[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- /loop subcommand control flags -------------------------------------------
// Set by `/loop stop` / `/loop fetch` while a run is in flight; read at loop
// checkpoints. stopRequested aborts at the next safe boundary (current poll
// interval or agent-turn end); fetchRequested wakes the Codex poll early.
// /loop resume re-enters runTask for `interruptedChange`.
let stopRequested = false;
let fetchRequested = false;
let interruptedChange: string | null = null;
const POLL_TICK_MS = 1000;

/** Like sleep(), but wakes every POLL_TICK_MS to check stop/fetch flags.
 *  Returns "stop" / "fetch" if the flag fired (fetch flag is consumed), else "ok". */
async function sleepPoll(ms: number): Promise<"ok" | "fetch" | "stop"> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (stopRequested) return "stop";
    if (fetchRequested) {
      fetchRequested = false;
      return "fetch";
    }
    await sleep(Math.min(POLL_TICK_MS, deadline - Date.now()));
  }
  return "ok";
}

/** Run a command via pi.exec, optionally in cwd; returns trimmed stdout + exit code. */
async function run(
  pi: ExtensionAPI,
  cmd: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await pi.exec(cmd, args, cwd ? { cwd } : undefined);
  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    code: r.code ?? 0,
  };
}

async function ghJson<T>(pi: ExtensionAPI, endpoint: string): Promise<T | null> {
  const { stdout, code } = await run(pi, "gh", ["api", endpoint]);
  if (code !== 0 || !stdout) return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

/** Find the todo file case-insensitively (todo.md / TODO.md / …). */
function findTodoFile(cwd: string): string | null {
  try {
    for (const entry of readdirSync(cwd)) {
      if (entry.toLowerCase() === "todo.md") return join(cwd, entry);
    }
  } catch {
    /* not a dir / unreadable */
  }
  return null;
}

/** First unchecked `- [ ] <change>` line (1-indexed) or null. */
function pickTask(cwd: string): { lineNo: number; text: string } | null {
  const file = findTodoFile(cwd);
  if (!file) return null;
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*\[\s\]\s+(.+?)\s*$/);
    if (m) return { lineNo: i + 1, text: m[1].trim() };
  }
  return null;
}

/** Flip a specific todo line from `- [ ]` to `- [x]`. */
function markDone(cwd: string, lineNo: number) {
  const file = findTodoFile(cwd);
  if (!file) return;
  const lines = readFileSync(file, "utf-8").split("\n");
  if (lineNo >= 1 && lineNo <= lines.length) {
    lines[lineNo - 1] = lines[lineNo - 1].replace(/-\s*\[\s\]/, "- [x]");
    writeFileSync(file, lines.join("\n"));
  }
}

/** Ensure <change> is an unchecked `- [ ]` line in the todo file; return its 1-indexed line number. */
function ensureTodoEntry(cwd: string, change: string): number {
  const file = findTodoFile(cwd) ?? join(cwd, "TODO.md");
  const raw = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const lines = raw.split("\n");
  const matches = (l: string) => {
    const m = l.match(/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/);
    return !!m && m[1].trim() === change;
  };
  const idx = lines.findIndex(matches);
  if (idx >= 0) return idx + 1;
  const prefix = raw && !raw.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${raw}${prefix}- [ ] ${change}\n`);
  return raw.split("\n").length + (prefix ? 1 : 0);
}

/** Append `entry` to .git/info/exclude (local-only) if not already present. Best-effort. */
async function ensureLocalIgnore(pi: ExtensionAPI, repoRoot: string, entry: string) {
  const { stdout: gitDir, code } = await run(pi, "git", ["rev-parse", "--git-dir"], repoRoot);
  if (code !== 0 || !gitDir) return;
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);
  const excludePath = join(absGitDir, "info", "exclude");
  try {
    const cur = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    if (cur.split("\n").some((l) => l.trim() === entry)) return;
    const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, `${cur}${prefix}\n# spec-codex-loop (local-only)\n${entry}\n`);
  } catch {
    /* non-fatal */
  }
}

/** Copy `.env*` files from the main repo into the worktree at the same
 *  relative path. These are nearly always gitignored, so the origin/main
 *  checkout the worktree is built from is missing them. Walks the whole tree
 *  (monorepo: env files can live under any package/app dir), skipping
 *  .git/node_modules/.worktree (the last avoids walking into the worktree we
 *  just created). Returns the number of files copied. */
function copyEnvFiles(repoRoot: string, wtDir: string): number {
  // .env and every variant (.env.local, .env.development, .env.[mode].local, …).
  // .envrc / .environment etc. don't match (no `.` right after `.env`).
  const isEnv = (name: string) => name === ".env" || name.startsWith(".env.");
  const skip = new Set([".git", "node_modules", WORKTREE_ROOT]);
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (isEnv(e.name)) {
        const dest = join(wtDir, relative(repoRoot, join(dir, e.name)));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(dir, e.name), dest);
        n++;
      }
    }
  };
  walk(repoRoot);
  return n;
}

/** Remove a change's worktree + its local branch. Best-effort. */
async function removeWorktree(pi: ExtensionAPI, repoRoot: string, change: string) {
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  await run(pi, "git", ["worktree", "remove", "--force", wtDir], repoRoot);
  await run(pi, "git", ["branch", "-D", change], repoRoot);
}

/** Open/merged PR state for a change's head branch (used for resume). */
async function prStateFor(
  pi: ExtensionAPI,
  repo: string,
  change: string
): Promise<{ open: boolean; merged: boolean; prNum: number | null }> {
  const lookup = async (state: string) => {
    const { stdout } = await run(pi, "gh", [
      "pr", "list", "--head", change, "--state", state, "--json", "number", "-q", ".[0].number", "--repo", repo,
    ]);
    return parseInt((stdout || "").trim(), 10) || null;
  };
  const openNum = await lookup("open");
  if (openNum) return { open: true, merged: false, prNum: openNum };
  const mergedNum = await lookup("merged");
  if (mergedNum) return { open: false, merged: true, prNum: mergedNum };
  return { open: false, merged: false, prNum: null };
}

// --- agent drive: one listener, no accumulation --------------------------------
let turnResolve: (() => void) | null = null;

function driveAgent(pi: ExtensionAPI, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      turnResolve = null;
      resolve();
    };
    turnResolve = finish;
    // Also resolve early if /loop stop fires mid-turn (loop exits at the next
    // boundary; the in-flight agent turn runs to its own end).
    const timer = setInterval(() => {
      if (stopRequested) finish();
    }, POLL_TICK_MS);
    pi.sendUserMessage(prompt);
  });
}

// --- Codex review polling ------------------------------------------------------
interface GhComment {
  id: number;
  user?: { login: string };
  created_at: string;
  body: string;
}
interface GhReview {
  id?: number;
  user?: { login: string };
  state: string;
  submitted_at: string;
  commit_id?: string;
  body?: string;
}
interface GhInlineComment extends GhComment {
  pull_request_review_id?: number;
  path?: string;
  line?: number | null;
  commit_id?: string;
}

function isCodex(login?: string): boolean {
  return !!login && login.startsWith(CODEX_LOGIN);
}

function parseSuggestion(c: GhInlineComment): Suggestion {
  const sev = /!\[(P\d)\s+Badge/i.exec(c.body)?.[1] ?? null;
  const cleaned = c.body
    .replace(/<\/?(sub|details|summary)>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\*\*/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const [titleLine, ...rest] = cleaned.split("\n");
  return {
    severity: sev,
    title: titleLine.trim(),
    body: rest.join("\n").trim(),
    path: c.path ?? null,
    line: c.line ?? null,
  };
}

function formatSuggestions(suggestions: Suggestion[]): string {
  return suggestions
    .map((s, i) => {
      const loc = s.path ? `${s.path}${s.line ? `:${s.line}` : ""}` : "(general)";
      const tag = s.severity ? `[${s.severity}]` : "[n/a]";
      return `${i + 1}. ${tag} ${loc} — ${s.title}\n${s.body}`;
    })
    .join("\n\n");
}

/** Stable key for a round's suggestion set — equal keys mean the same review came back. */
function suggestionKey(suggestions: Suggestion[]): string {
  return suggestions
    .map((s) => `${s.path ?? ""}:${s.line ?? 0}|${s.title}`)
    .sort()
    .join("\n");
}

const shortSha = (sha: string) => sha.slice(0, 7);

/** SHA of the commit a Codex pass comment reviewed, parsed from its body
 *  (`**Reviewed commit:** \`<sha>\``). null if absent. */
function passCommit(body: string): string | null {
  return /Reviewed commit:\D{0,5}([0-9a-f]{7,40})/i.exec(body)?.[1] ?? null;
}

/** created_at of the newest issue comment on the PR — used to timestamp a
 *  just-posted `@codex review` trigger so quota detection can be gated on
 *  freshness (GitHub's clock, not local). */
async function latestCommentAt(pi: ExtensionAPI, repo: string, prNum: number): Promise<string> {
  const comments =
    (await ghJson<GhComment[]>(pi, `repos/${repo}/issues/${prNum}/comments?per_page=100`)) ?? [];
  return comments[comments.length - 1]?.created_at ?? "";
}

/** Codex's verdict for `head`, or null if Codex hasn't reviewed this commit.
 *  Verdicts are keyed on the commit SHA, not wall-clock, so a stop/resume can't
 *  hide a verdict Codex already gave:
 *  - pass: a pass issue-comment whose "Reviewed commit" is this head.
 *  - fail: a Codex review on this head → its inline comments, scoped by review id
 *    (the inline comments' own commit_id is unreliable — on a real PR it carried a
 *    third unrelated SHA, so it cannot be used to associate comments).
 *  - quota: only when `triggerAt` is set and a quota comment landed after it, so a
 *    stale quota from before this trigger (e.g. across a resume) can't fire.
 *  Pass takes precedence over a later fail review for the same commit — Codex is
 *  nondeterministic, so re-reviewing an already-passed commit is noise. */
async function readCodexVerdict(
  pi: ExtensionAPI,
  repo: string,
  prNum: number,
  head: string,
  triggerAt: string | null
): Promise<PollResult | null> {
  const head7 = shortSha(head);
  const issueComments =
    (await ghJson<GhComment[]>(pi, `repos/${repo}/issues/${prNum}/comments?per_page=100`)) ?? [];
  const codexIssue = issueComments.filter((c) => isCodex(c.user?.login));

  if (
    codexIssue.some((c) => PASS_RE.test(c.body) && shortSha(passCommit(c.body) ?? "") === head7)
  ) {
    return { pass: true, timeout: false, stopped: false, quotaExhausted: false, suggestions: [] };
  }
  if (triggerAt && codexIssue.some((c) => QUOTA_RE.test(c.body) && c.created_at > triggerAt)) {
    return { pass: false, timeout: false, stopped: false, quotaExhausted: true, suggestions: [] };
  }

  const reviews =
    (await ghJson<GhReview[]>(pi, `repos/${repo}/pulls/${prNum}/reviews?per_page=100`)) ?? [];
  const headReviewIds = new Set(
    reviews
      .filter(
        (r) => isCodex(r.user?.login) && shortSha(r.commit_id ?? "") === head7 && r.id != null
      )
      .map((r) => r.id as number)
  );
  if (headReviewIds.size > 0) {
    const inline =
      (await ghJson<GhInlineComment[]>(pi, `repos/${repo}/pulls/${prNum}/comments?per_page=100`)) ??
      [];
    const suggestions = inline
      .filter(
        (c) =>
          isCodex(c.user?.login) &&
          c.pull_request_review_id != null &&
          headReviewIds.has(c.pull_request_review_id)
      )
      .map(parseSuggestion)
      .filter((s) => s.title);
    return { pass: false, timeout: false, stopped: false, quotaExhausted: false, suggestions };
  }
  return null;
}

/** Poll readCodexVerdict every REVIEW_WAIT_MS until a verdict lands or the cap hits. */
async function pollCodexVerdict(
  pi: ExtensionAPI,
  ctx: any,
  repo: string,
  prNum: number,
  head: string,
  triggerAt: string
): Promise<PollResult> {
  const deadline = Date.now() + REVIEW_TOTAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Check before sleeping: a verdict may already be on the PR — Codex may have
    // finished while the loop was stopped, or replied quickly after the trigger.
    const v = await readCodexVerdict(pi, repo, prNum, head, triggerAt);
    if (v) return v;
    ctx.ui.notify(
      `dev-loop: no Codex verdict for ${shortSha(head)} yet; retrying in ${REVIEW_WAIT_MS / 60000}min…`,
      "info"
    );
    const wake = await sleepPoll(REVIEW_WAIT_MS);
    if (wake === "stop") {
      return { pass: false, timeout: false, stopped: true, quotaExhausted: false, suggestions: [] };
    }
    // wake === "fetch" (flag consumed) or "ok" → loop and re-check now.
  }
  return { pass: false, timeout: true, stopped: false, quotaExhausted: false, suggestions: [] };
}

// --- agent-driven phases (each scoped to the change's worktree) ----------------
async function buildPhase(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  wtDir: string,
  dryRun: boolean
) {
  const prompt = [
    `Implement the OpenSpec change "${change}" by following the openspec-apply-change skill.`,
    "",
    `ALL work happens inside this git worktree. Use absolute paths under it, and prefix`,
    `every shell command with \`cd ${wtDir} &&\` (the shell does not stay in any directory):`,
    `  ${wtDir}`,
    "",
    "In that worktree, follow the skill flow:",
    `  openspec status --change "${change}" --json`,
    `  openspec instructions apply --change "${change}" --json`,
    "Read the contextFiles it lists, then implement every pending task in tasks.md,",
    "flipping each `- [ ]` to `- [x]` as you complete it. Run the project's tests and fix",
    "until green. If you hit a real blocker, stop and report — do not guess.",
    "",
    "Then commit with a clear conventional message.",
    dryRun
      ? "Stop when committed (--dry-run: do not push or open a PR)."
      : [
          "Then ship it:",
          `  git push -u origin ${change}`,
          `  gh pr create --title "${change}" --head ${change} --body "Implements OpenSpec change ${change}."`,
          "Stop only once the PR is open.",
        ].join("\n"),
  ].join("\n");
  ctx.ui.notify(`dev-loop: building ${change} (driving agent in worktree…)`, "info");
  await driveAgent(pi, prompt);
}

async function fixPhase(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  wtDir: string,
  prNum: number,
  round: number,
  suggestions: Suggestion[]
) {
  const prompt = [
    `Codex review (round ${round}) on PR #${prNum} for change "${change}" raised the comments below.`,
    `Address each one. Work inside the worktree (absolute paths under it; prefix shell`,
    `commands with \`cd ${wtDir} &&\`), run tests, then commit. Do NOT push.`,
    "",
    formatSuggestions(suggestions),
  ].join("\n");
  ctx.ui.notify(`dev-loop: addressing round ${round} review (driving agent…)`, "info");
  await driveAgent(pi, prompt);
}

let loopActive = false; // true while a /loop run (runTask) is in flight — read by the input handler

/** Precondition checks shared by the normal run and /loop resume. */
async function checkPreconditions(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  for (const cmd of ["git", "gh", "openspec"]) {
    const { code } = await run(pi, "sh", ["-c", `command -v ${cmd}`]);
    if (code !== 0) {
      ctx.ui.notify(`dev-loop: required command missing: ${cmd}`, "error");
      return false;
    }
  }
  const { code: osDir } = await run(pi, "sh", ["-c", `test -d openspec`]);
  if (osDir !== 0) {
    ctx.ui.notify("dev-loop: no openspec/ dir — run `/loop init` first", "error");
    return false;
  }
  return true;
}

/** Wraps runTask to toggle loopActive (read by the input handler). */
async function runTaskGuarded(pi: ExtensionAPI, ctx: any, change: string, dryRun: boolean): Promise<boolean> {
  loopActive = true;
  try {
    return await runTask(pi, ctx, change, dryRun);
  } finally {
    loopActive = false;
  }
}

// --- per-change pipeline -------------------------------------------------------
async function runTask(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  dryRun: boolean
): Promise<boolean> {
  const repoRoot = ctx.cwd as string;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);

  ctx.ui.notify(`dev-loop: change → ${change} (worktree ${wtDir})`, "info");

  // Fresh run: clear any stale control flags left by a previous /loop stop.
  stopRequested = false;
  fetchRequested = false;

  await ensureLocalIgnore(pi, repoRoot, `${WORKTREE_ROOT}/`);

  // Resolve repo + detect prior-run state (for resume).
  const { stdout: repoOut } = await run(pi, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot);
  const repo = repoOut || "";
  if (!repo) {
    ctx.ui.notify("dev-loop: could not resolve repo via `gh repo view`", "error");
    return false;
  }
  const pr = await prStateFor(pi, repo, change);

  // Already merged in a prior run, but cleanup / TODO-mark didn't finish → finish up.
  if (pr.merged) {
    if (existsSync(wtDir)) await removeWorktree(pi, repoRoot, change);
    ctx.ui.notify(`dev-loop: ${change} already merged in a prior run — cleaning up`, "info");
    return true;
  }

  // Create the worktree only on a fresh run; a resume reuses the existing one.
  if (!existsSync(wtDir)) {
    const { stderr: fetchErr, code: fetchCode } = await run(pi, "git", ["fetch", "origin", "main"], repoRoot);
    if (fetchCode !== 0) {
      ctx.ui.notify(`dev-loop: git fetch origin main failed: ${fetchErr}`, "error");
      return false;
    }
    const { stderr: wtErr, code: wtCode } = await run(
      pi,
      "git",
      ["worktree", "add", "-b", change, wtDir, "origin/main"],
      repoRoot
    );
    if (wtCode !== 0) {
      ctx.ui.notify(`dev-loop: git worktree add failed: ${wtErr}`, "error");
      return false;
    }
  } else {
    ctx.ui.notify(`dev-loop: resuming — reusing worktree ${wtDir}`, "info");
  }

  // Bring gitignored .env* (monorepo-wide) into the worktree.
  const envCopied = copyEnvFiles(repoRoot, wtDir);
  if (envCopied) {
    ctx.ui.notify(`dev-loop: copied ${envCopied} env file(s) (.env*) into worktree`, "info");
  }

  // Ensure openspec is present in the worktree. The worktree is created from
  // origin/main, so if openspec isn't there yet (git-ignored, or just never
  // committed), copy the whole dir from the main repo — not committed, since in
  // the ignored case `git add` can't and in the merely-untracked case
  // scaffolding shouldn't pollute the PR. Otherwise, if openspec is on main but
  // this change isn't, bring in just the change dir and commit it on the branch.
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (!existsSync(join(wtDir, "openspec"))) {
    cpSync(join(repoRoot, "openspec"), join(wtDir, "openspec"), { recursive: true });
    ctx.ui.notify("dev-loop: no openspec/ in worktree — copied openspec/ from main repo", "info");
  } else if (!existsSync(wtChangeDir)) {
    const srcChangeDir = join(repoRoot, "openspec", "changes", change);
    if (!existsSync(srcChangeDir)) {
      ctx.ui.notify(`dev-loop: openspec change "${change}" not found under openspec/changes/; aborting`, "error");
      await removeWorktree(pi, repoRoot, change);
      return false;
    }
    cpSync(srcChangeDir, wtChangeDir, { recursive: true });
    await run(pi, "git", ["add", `openspec/changes/${change}`], wtDir);
    await run(pi, "git", ["commit", "-m", `spec: add ${change} change`], wtDir);
  }

  // buildPhase — skip if a PR is already open (build shipped in a prior run).
  if (dryRun) {
    if (!pr.open) await buildPhase(pi, ctx, change, wtDir, true);
    ctx.ui.notify(`dev-loop: --dry-run → stopping (worktree left at ${wtDir})`, "info");
    return false;
  }
  let prNum: number;
  if (pr.open) {
    prNum = pr.prNum as number;
    ctx.ui.notify(`dev-loop: resuming — PR #${prNum} already open`, "info");
  } else {
    await buildPhase(pi, ctx, change, wtDir, false);
    if (stopRequested) {
      interruptedChange = change;
      ctx.ui.notify(`dev-loop: stopped during build — worktree left; use /loop resume`, "warning");
      return false;
    }
    // buildPhase must have opened a PR (also catches the agent working outside
    // the worktree — no push of <change> ⇒ no PR).
    const after = await prStateFor(pi, repo, change);
    if (!after.open) {
      ctx.ui.notify("dev-loop: no open PR after buildPhase; aborting (worktree left)", "error");
      return false;
    }
    prNum = after.prNum as number;
  }
  ctx.ui.notify(`dev-loop: PR #${prNum} — starting Codex review loop`, "info");

  // Review loop — keeps fixing until Codex passes; git ops target the worktree.
  // Verdicts are keyed on the HEAD commit, not wall-clock: a pass/fail review
  // already on the current head is reused instead of re-triggering, so a stop
  // mid-review or a resume can't blind the loop to a verdict Codex already gave.
  const seenSignatures: string[] = [];
  for (let round = 1; ; round++) {
    // Reconcile local HEAD with origin/<change> before trusting it for verdict
    // matching (readCodexVerdict keys on local HEAD) and for the fast-forward
    // push below. "local ≠ origin" splits into two opposite cases:
    //   - local ahead (a manual commit, or a push that failed silently last
    //     round): fast-forward push to self-heal, then proceed.
    //   - origin ahead or diverged (GitHub "Update branch", a collaborator, a
    //     CI bot): stop for a human — the push would be non-fast-forward and the
    //     review would land on the wrong head.
    await run(pi, "git", ["fetch", "origin", change], wtDir);
    const { stdout: localHead } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
    const { stdout: remoteHead } = await run(pi, "git", ["rev-parse", `origin/${change}`], wtDir);
    if (remoteHead && localHead && remoteHead !== localHead) {
      // exit 0 => remoteHead is an ancestor of localHead => local is ahead (FF).
      const { code: ffCode } = await run(
        pi, "git", ["merge-base", "--is-ancestor", remoteHead, localHead], wtDir,
      );
      if (ffCode === 0) {
        const { code: syncCode, stderr: syncErr } = await run(pi, "git", ["push"], wtDir);
        if (syncCode !== 0) {
          interruptedChange = change;
          ctx.ui.notify(
            `dev-loop: sync push failed (${syncErr}); stopping (PR + worktree left) — fix then /loop resume`,
            "error",
          );
          return false;
        }
      } else {
        interruptedChange = change;
        ctx.ui.notify(
          `dev-loop: origin/${change} ${shortSha(remoteHead)} is ahead of / diverged from local ${shortSha(localHead)} (external push/merge, e.g. "Update branch"); stopping — resolve then /loop resume`,
          "error",
        );
        return false;
      }
    }
    const head = localHead;
    let result = await readCodexVerdict(pi, repo, prNum, head, null);
    if (!result) {
      const { code: trigCode, stderr: trigErr } = await run(pi, "gh", [
        "pr", "comment", String(prNum), "--body", "@codex review", "--repo", repo,
      ]);
      if (trigCode !== 0) {
        ctx.ui.notify(`dev-loop: trigger @codex review failed: ${trigErr}`, "error");
        return false;
      }
      // Gate quota on this trigger's timestamp so a stale quota comment (e.g. from
      // before a resume) can't fire; only a fresh quota response stops the loop.
      const triggerAt = await latestCommentAt(pi, repo, prNum);
      ctx.ui.notify(
        `dev-loop: round ${round} on ${shortSha(head)} — polling Codex every ${REVIEW_WAIT_MS / 60000}min (≤${REVIEW_TOTAL_TIMEOUT_MS / 60000}min)…`,
        "info"
      );
      result = await pollCodexVerdict(pi, ctx, repo, prNum, head, triggerAt);
    } else {
      ctx.ui.notify(
        `dev-loop: round ${round} on ${shortSha(head)} — reusing existing Codex verdict`,
        "info"
      );
    }

    if (result.stopped) {
      interruptedChange = change;
      ctx.ui.notify(`dev-loop: stopped by /loop stop — PR + worktree left; use /loop resume`, "warning");
      return false;
    }
    if (result.quotaExhausted) {
      interruptedChange = change;
      ctx.ui.notify(
        `dev-loop: Codex review quota exhausted — stopping (PR + worktree left); use /loop resume after the quota resets`,
        "warning"
      );
      return false;
    }
    if (result.pass) {
      ctx.ui.notify(`dev-loop: Codex passed on round ${round}`, "info");
      break;
    }
    if (result.timeout) {
      ctx.ui.notify(
        `dev-loop: no Codex review after ${REVIEW_TOTAL_TIMEOUT_MS / 60000}min on round ${round}; stopping (PR + worktree left)`,
        "warning"
      );
      return false;
    }
    if (result.suggestions.length === 0) {
      ctx.ui.notify(`dev-loop: round ${round} review had no actionable items; treating as pass`, "info");
      break;
    }

    // Flip-flop guard: same review set we already fixed → fixes aren't landing.
    const sig = suggestionKey(result.suggestions);
    if (seenSignatures.includes(sig)) {
      ctx.ui.notify(
        `dev-loop: round ${round} repeats a prior review (fixes not landing); stopping (PR + worktree left)`,
        "warning"
      );
      return false;
    }
    seenSignatures.push(sig);

    const { stdout: headPre } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
    await fixPhase(pi, ctx, change, wtDir, prNum, round, result.suggestions);
    if (stopRequested) {
      interruptedChange = change;
      ctx.ui.notify(`dev-loop: stopped during fix round ${round} — PR + worktree left; use /loop resume`, "warning");
      return false;
    }
    const { stdout: headPost } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
    if (headPre === headPost) {
      ctx.ui.notify(`dev-loop: agent made no progress on round ${round}; stopping (PR + worktree left)`, "warning");
      return false;
    }
    // A failed push (non-fast-forward from an external advance, network, auth)
    // used to be swallowed silently — the loop kept committing locally while the
    // PR never advanced. Treat any push failure as terminal so the divergence
    // surfaces instead of rotting for N rounds.
    const { code: pushCode, stderr: pushErr } = await run(pi, "git", ["push"], wtDir);
    if (pushCode !== 0) {
      interruptedChange = change;
      ctx.ui.notify(
        `dev-loop: git push failed on round ${round} (${pushErr}); stopping (PR + worktree left) — fix then /loop resume`,
        "error",
      );
      return false;
    }
  }

  // Archive the change (fold specs into openspec/specs, move to archive/). Idempotent on resume.
  if (existsSync(wtChangeDir)) {
    const { code: arcCode, stderr: arcErr } = await run(pi, "openspec", ["archive", change, "-y"], wtDir);
    if (arcCode !== 0) {
      ctx.ui.notify(`dev-loop: openspec archive failed: ${arcErr}; stopping (PR + worktree left)`, "warning");
      return false;
    }
    const { stdout: dirty } = await run(pi, "git", ["status", "--porcelain"], wtDir);
    if (dirty) {
      await run(pi, "git", ["add", "-A"], wtDir);
      await run(pi, "git", ["commit", "-m", `chore: archive ${change}`], wtDir);
      const { code: arcPushCode, stderr: arcPushErr } = await run(pi, "git", ["push"], wtDir);
      if (arcPushCode !== 0) {
        interruptedChange = change;
        ctx.ui.notify(
          `dev-loop: git push of archive commit failed (${arcPushErr}); stopping (PR + worktree left) — fix then /loop resume`,
          "error",
        );
        return false;
      }
    }
  }

  // Merge directly — Codex passed, so conditions are met.
  const { code: mergeCode, stderr: mergeErr } = await run(pi, "gh", [
    "pr", "merge", String(prNum), "--squash", "--delete-branch", "--repo", repo,
  ]);
  if (mergeCode !== 0) {
    ctx.ui.notify(`dev-loop: gh pr merge failed: ${mergeErr}`, "error");
    return false;
  }
  await removeWorktree(pi, repoRoot, change);
  ctx.ui.notify(`dev-loop: merged PR #${prNum} + removed worktree ✅`, "info");
  return true;
}

// --- project init (/loop init) ------------------------------------------------
async function initProject(pi: ExtensionAPI, ctx: any) {
  const cwd = ctx.cwd as string;

  // 1. TODO.md — the loop's change backlog.
  const todoPath = findTodoFile(cwd) ?? join(cwd, "TODO.md");
  if (existsSync(todoPath)) {
    ctx.ui.notify("dev-loop: TODO.md already exists", "info");
  } else {
    writeFileSync(
      todoPath,
      [
        "# TODO",
        "",
        "<!-- spec-codex-loop: one OpenSpec change name per checkbox line, e.g.",
        "     - [ ] add-user-auth",
        "     The change must exist under openspec/changes/. Example lines below are",
        "     intentionally not written as literal checkbox lines so the loop skips them. -->",
        "",
      ].join("\n")
    );
    ctx.ui.notify("dev-loop: created TODO.md", "info");
  }

  // 2. Keep TODO.md + .worktree/ out of git via the local-only exclude.
  await ensureLocalIgnore(pi, cwd, "TODO.md");
  await ensureLocalIgnore(pi, cwd, `${WORKTREE_ROOT}/`);

  // 3. OpenSpec scaffolding, non-interactive and pi-targeted.
  if (existsSync(join(cwd, "openspec"))) {
    ctx.ui.notify("dev-loop: openspec/ already present", "info");
  } else {
    const { code, stderr } = await run(pi, "openspec", ["init", "--tools", "pi"]);
    if (code === 0) ctx.ui.notify("dev-loop: ran `openspec init --tools pi`", "info");
    else ctx.ui.notify(`dev-loop: openspec init failed: ${stderr}`, "error");
  }
}

// --- entry point ---------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.on("agent_end", () => {
    const r = turnResolve;
    turnResolve = null;
    r && r();
  });

  // While a /loop run is in flight, free-text submits don't help (only
  // /loop stop|fetch|resume do). Slash commands bypass this event, so they still
  // work; this just reminds the user + consumes stray free-text that would
  // otherwise cut the loop's agent turn short. The loop's own sendUserMessage
  // calls have source "extension" and pass through unchanged.
  pi.on("input", async (event, ctx) => {
    if (loopActive && event.source === "interactive") {
      ctx.ui.notify("dev-loop is running — use /loop stop | /loop fetch | /loop resume (free-text is ignored)", "info");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.registerCommand("loop", {
    description:
      "Autonomous OpenSpec-change → worktree → PR → Codex review → archive → merge loop. Subcommands: stop | fetch | resume. Flags: --dry-run --all",
    handler: async (args, ctx) => {
      const argv = String(args ?? "").trim();
      const tokens = argv.split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (sub === "init") {
        await initProject(pi, ctx);
        return;
      }

      // Control subcommands — run concurrently with an in-flight /loop; they
      // just flip module-level flags the loop reads at its checkpoints. Slash
      // commands bypass the input event, so these always reach the handler.
      if (sub === "stop") {
        if (!loopActive) { ctx.ui.notify("dev-loop: no /loop is running", "warning"); return; }
        stopRequested = true;
        ctx.ui.notify("dev-loop: stop requested — will stop after the current step (PR + worktree kept)", "warning");
        return;
      }
      if (sub === "fetch") {
        if (!loopActive) { ctx.ui.notify("dev-loop: no /loop is running", "warning"); return; }
        fetchRequested = true;
        ctx.ui.notify("dev-loop: fetch requested — will re-poll Codex review now", "info");
        return;
      }
      if (sub === "resume") {
        if (!interruptedChange) {
          ctx.ui.notify("dev-loop: nothing to resume (no change stopped via /loop stop)", "warning");
          return;
        }
        if (!(await checkPreconditions(pi, ctx))) return;
        const ch = interruptedChange;
        ctx.ui.notify(`dev-loop: resuming "${ch}"`, "info");
        const merged = await runTaskGuarded(pi, ctx, ch, false);
        if (merged) ctx.ui.notify(`dev-loop: "${ch}" merged ✅`, "info");
        return;
      }

      // Normal run: /loop [change] [--dry-run] [--all].
      const dryRun = tokens.includes("--dry-run");
      const all = tokens.includes("--all");
      const positional = tokens.filter((t) => !t.startsWith("--"));
      const oneOff = positional.join(" ").trim(); // a change name, run directly
      const cwd = ctx.cwd as string;

      if (!(await checkPreconditions(pi, ctx))) return;

      if (oneOff) {
        if (!existsSync(join(cwd, "openspec", "changes", oneOff))) {
          ctx.ui.notify(`dev-loop: change "${oneOff}" not found under openspec/changes/`, "error");
          return;
        }
      } else if (!pickTask(cwd)) {
        ctx.ui.notify("dev-loop: no unchecked `- [ ] <change>` line in TODO.md", "warning");
        return;
      }

      // Single change (one-off arg) or iterate TODO until done / --all.
      while (true) {
        let item: { text: string; lineNo: number | null } | null;
        if (oneOff) {
          const lineNo = ensureTodoEntry(cwd, oneOff);
          item = { text: oneOff, lineNo };
        } else {
          const t = pickTask(cwd);
          item = t ? { text: t.text, lineNo: t.lineNo } : null;
        }
        if (!item) {
          ctx.ui.notify("dev-loop: no more changes", "info");
          break;
        }
        const merged = await runTaskGuarded(pi, ctx, item.text, dryRun);
        if (merged && item.lineNo) markDone(cwd, item.lineNo);
        if (oneOff) break;
        if (!all) {
          ctx.ui.notify("dev-loop: one change done (use --all to continue)", "info");
          break;
        }
      }
    },
  });
}
