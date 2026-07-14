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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PHASE, REVIEW_INNER } from "./lifecycle-state.ts";

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
// Control sentinels (created at repo root) — the cross-terminal control path.
// /loop fetch|stop now reach the loop in real time via the non-blocking driver,
// but only inside the pi session; a 1s sentinel ticker (startSentinelTicker)
// lets `touch` from ANY terminal (another shell, SSH) do the same.
const FETCH_SENTINEL = ".dev-loop-fetch";
const STOP_SENTINEL = ".dev-loop-stop";

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

/** Apply a control signal (fetch/stop). Sets the flag the chain checks, and —
 *  if a loop is running — cancels the review_wait timer and (for fetch) re-enters
 *  the chain immediately. With the non-blocking driver, /loop fetch|stop reach
 *  here in real time (no command-dispatch queue), so this is the live control
 *  path; sentinel files route through it too for cross-terminal use. */
function applyControl(ctx: any, kind: "fetch" | "stop") {
  if (kind === "fetch") fetchRequested = true; else stopRequested = true;
  ctx.ui.notify(
    kind === "stop" ? "dev-loop: stop requested — next safe boundary" : "dev-loop: fetch requested — rechecking now",
    kind === "stop" ? "warning" : "info",
  );
  if (!runCtx) return;
  clearWaitTimer(runCtx.change);
  if (kind === "fetch" && !stepping) void runLoopChain();
}

/** Command path: write the sentinel (cross-terminal trigger) then apply. */
function writeControl(ctx: any, sentinel: string, kind: "fetch" | "stop") {
  try { writeFileSync(join(ctx.cwd as string, sentinel), ""); } catch { /* non-fatal */ }
  applyControl(ctx, kind);
}

// --- re-entrant loop state machine (review de-block) --------------------------
// pi serializes command dispatch behind a running /loop handler, so the review
// poll can't `await sleep` inside the handler. Instead the loop persists its
// phase/inner-state to .worktree/<change>/.loop-state.json, runs ONE transition
// per chain step, and on review_wait schedules a setTimeout + returns. The
// timer, /loop fetch, or /loop resume re-enter runLoopChain, which walks steps
// (yielding via setImmediate between them) until it suspends or finishes.
let piRef: ExtensionAPI | null = null;
let stepping = false;                                  // mutex: one chain entry at a time
const waitTimers = new Map<string, NodeJS.Timeout>();
let sentinelTicker: NodeJS.Timeout | null = null;
let runCtx: { ctx: any; change: string; dryRun: boolean; all: boolean; oneOff: boolean } | null = null;
const LOOP_STATE_FILE = ".loop-state.json";

interface LoopState {
  phase: string;
  inner: string | null;
  round: number;
  prNum: number;
  head: string;
  repo: string;
  triggerAt: string | null;
  reviewDeadline: number | null;
  seenSignatures: string[];
  suggestions: Suggestion[];
  stopReason: string | null;
}

function statePath(repoRoot: string, change: string): string {
  return join(repoRoot, WORKTREE_ROOT, change, LOOP_STATE_FILE);
}
function readLoopState(repoRoot: string, change: string): LoopState | null {
  try {
    const p = statePath(repoRoot, change);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as LoopState;
  } catch { return null; }
}
function writeLoopState(repoRoot: string, change: string, s: LoopState): void {
  const p = statePath(repoRoot, change);
  const tmp = `${p}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, p); } catch { /* resume re-derives */ }
}
function clearLoopState(repoRoot: string, change: string): void {
  try { unlinkSync(statePath(repoRoot, change)); } catch { /* already gone */ }
}
function clearWaitTimer(change: string): void {
  const t = waitTimers.get(change);
  if (t) { clearTimeout(t); waitTimers.delete(change); }
}
function scheduleWait(ms: number): void {
  if (!runCtx) return;
  const change = runCtx.change;
  clearWaitTimer(change);
  const t = setTimeout(() => { void runLoopChain(); }, ms);
  t.unref?.();
  waitTimers.set(change, t);
}
const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** 1s ticker that turns a sentinel file (touched from any terminal) into a
 *  control signal — the cross-terminal path, since /loop fetch|stop only work
 *  inside the pi session. Runs only while a loop is active. */
function startSentinelTicker(ctx: any): void {
  stopSentinelTicker();
  sentinelTicker = setInterval(() => {
    if (!runCtx) return;
    const root = ctx.cwd as string;
    const stopP = join(root, STOP_SENTINEL);
    const fetchP = join(root, FETCH_SENTINEL);
    if (existsSync(stopP)) { try { unlinkSync(stopP); } catch { /* gone */ } applyControl(ctx, "stop"); }
    else if (existsSync(fetchP)) { try { unlinkSync(fetchP); } catch { /* gone */ } applyControl(ctx, "fetch"); }
  }, POLL_TICK_MS);
  sentinelTicker.unref?.();
}
function stopSentinelTicker(): void {
  if (sentinelTicker) { clearInterval(sentinelTicker); sentinelTicker = null; }
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
// --- per-change pipeline (re-entrant state machine) ---------------------------
// runPrefix: resolve → provision → build (linear; agent turns, pi steer-OK).
//   Returns at the review boundary; never blocks on a poll.
// oneStep: one transition of the review inner machine OR the archive/merge/cleanup
//   suffix; writes state, returns cont|suspend|done|stop.
// driveChange: drives one change from current state to suspend/completion.
// runLoopChain: entry; serializes steps (setImmediate yield), chains --all, toggles
//   loopActive, owns the sentinel ticker + wait timer lifecycle.

type PrefixResult =
  | { kind: "atReview"; prNum: number; head: string; repo: string }
  | { kind: "stop" }
  | { kind: "merged" }
  | { kind: "abort" }
  | { kind: "dryRun" };

async function runPrefix(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  dryRun: boolean
): Promise<PrefixResult> {
  const repoRoot = ctx.cwd as string;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);

  ctx.ui.notify(`dev-loop: change → ${change} (worktree ${wtDir})`, "info");

  // Fresh run: clear any stale control flags + sentinels left by a previous run.
  stopRequested = false;
  fetchRequested = false;
  for (const s of [FETCH_SENTINEL, STOP_SENTINEL]) {
    try { unlinkSync(join(repoRoot, s)); } catch { /* already gone */ }
  }

  await ensureLocalIgnore(pi, repoRoot, `${WORKTREE_ROOT}/`);
  await ensureLocalIgnore(pi, repoRoot, FETCH_SENTINEL);
  await ensureLocalIgnore(pi, repoRoot, STOP_SENTINEL);
  await ensureLocalIgnore(pi, repoRoot, LOOP_STATE_FILE);

  const { stdout: repoOut } = await run(pi, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot);
  const repo = repoOut || "";
  if (!repo) {
    ctx.ui.notify("dev-loop: could not resolve repo via `gh repo view`", "error");
    return { kind: "abort" };
  }
  const pr = await prStateFor(pi, repo, change);

  // Already merged in a prior run → finish cleanup.
  if (pr.merged) {
    if (existsSync(wtDir)) await removeWorktree(pi, repoRoot, change);
    ctx.ui.notify(`dev-loop: ${change} already merged in a prior run — cleaning up`, "info");
    return { kind: "merged" };
  }

  // Create the worktree only on a fresh run; a resume reuses the existing one.
  if (!existsSync(wtDir)) {
    const { stderr: fetchErr, code: fetchCode } = await run(pi, "git", ["fetch", "origin", "main"], repoRoot);
    if (fetchCode !== 0) {
      ctx.ui.notify(`dev-loop: git fetch origin main failed: ${fetchErr}`, "error");
      return { kind: "abort" };
    }
    const { stderr: wtErr, code: wtCode } = await run(
      pi,
      "git",
      ["worktree", "add", "-b", change, wtDir, "origin/main"],
      repoRoot
    );
    if (wtCode !== 0) {
      ctx.ui.notify(`dev-loop: git worktree add failed: ${wtErr}`, "error");
      return { kind: "abort" };
    }
  } else {
    ctx.ui.notify(`dev-loop: resuming — reusing worktree ${wtDir}`, "info");
  }

  const envCopied = copyEnvFiles(repoRoot, wtDir);
  if (envCopied) {
    ctx.ui.notify(`dev-loop: copied ${envCopied} env file(s) (.env*) into worktree`, "info");
  }

  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (!existsSync(join(wtDir, "openspec"))) {
    cpSync(join(repoRoot, "openspec"), join(wtDir, "openspec"), { recursive: true });
    ctx.ui.notify("dev-loop: no openspec/ in worktree — copied openspec/ from main repo", "info");
  } else if (!existsSync(wtChangeDir)) {
    const srcChangeDir = join(repoRoot, "openspec", "changes", change);
    if (!existsSync(srcChangeDir)) {
      ctx.ui.notify(`dev-loop: openspec change "${change}" not found under openspec/changes/; aborting`, "error");
      await removeWorktree(pi, repoRoot, change);
      return { kind: "abort" };
    }
    cpSync(srcChangeDir, wtChangeDir, { recursive: true });
    await run(pi, "git", ["add", `openspec/changes/${change}`], wtDir);
    await run(pi, "git", ["commit", "-m", `spec: add ${change} change`], wtDir);
  }

  if (dryRun) {
    if (!pr.open) await buildPhase(pi, ctx, change, wtDir, true);
    ctx.ui.notify(`dev-loop: --dry-run → stopping (worktree left at ${wtDir})`, "info");
    return { kind: "dryRun" };
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
      return { kind: "stop" };
    }
    const after = await prStateFor(pi, repo, change);
    if (!after.open) {
      ctx.ui.notify("dev-loop: no open PR after buildPhase; aborting (worktree left)", "error");
      return { kind: "abort" };
    }
    prNum = after.prNum as number;
  }

  ctx.ui.notify(`dev-loop: PR #${prNum} — starting Codex review loop`, "info");
  const { stdout: head } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
  return { kind: "atReview", prNum, head, repo };
}

/** Find the change's checkbox line and flip it to [x]. */
function markChangeDone(cwd: string, change: string): void {
  const t = pickTask(cwd);
  if (t && t.text === change) markDone(cwd, t.lineNo);
  else markDone(cwd, ensureTodoEntry(cwd, change));
}

/** WAIT-step decision (pure, for testability). Precedence: a fetch request
 *  preempts the deadline — an explicit "recheck now" always re-probes, even if
 *  the cap elapsed, instead of timing out. */
export function waitAction(fetchRequested: boolean, reviewDeadline: number | null, now: number): "recheck" | "timeout" | "wait" {
  if (fetchRequested) return "recheck";
  if (reviewDeadline !== null && now > reviewDeadline) return "timeout";
  return "wait";
}

/** One state-machine transition. Mutates `s` and persists it. */
async function oneStep(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  s: LoopState
): Promise<"cont" | "suspend" | "done" | "stop"> {
  const repoRoot = ctx.cwd as string;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  const persist = () => writeLoopState(repoRoot, change, s);

  if (s.phase === PHASE.REVIEW) {
    if (s.inner === REVIEW_INNER.RECONCILE) {
      await run(pi, "git", ["fetch", "origin", change], wtDir);
      const { stdout: localHead } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
      const { stdout: remoteHead } = await run(pi, "git", ["rev-parse", `origin/${change}`], wtDir);
      if (remoteHead && localHead && remoteHead !== localHead) {
        const { code: ffCode } = await run(pi, "git", ["merge-base", "--is-ancestor", remoteHead, localHead], wtDir);
        if (ffCode === 0) {
          const { code, stderr } = await run(pi, "git", ["push"], wtDir);
          if (code !== 0) {
            s.stopReason = "sync_push_failed"; interruptedChange = change;
            ctx.ui.notify(`dev-loop: sync push failed (${stderr}); stopping — fix then /loop resume`, "error");
            persist(); return "stop";
          }
        } else {
          s.stopReason = "diverged"; interruptedChange = change;
          ctx.ui.notify(`dev-loop: origin/${change} ${shortSha(remoteHead)} ahead of / diverged from local ${shortSha(localHead)}; stopping — resolve then /loop resume`, "error");
          persist(); return "stop";
        }
      }
      s.head = localHead;
      s.inner = REVIEW_INNER.PROBE; persist(); return "cont";
    }
    if (s.inner === REVIEW_INNER.PROBE) {
      const v = await readCodexVerdict(pi, s.repo, s.prNum, s.head, s.triggerAt);
      if (!v) {
        s.inner = s.triggerAt ? REVIEW_INNER.WAIT : REVIEW_INNER.TRIGGER;
        persist(); return "cont";
      }
      if (v.pass || v.suggestions.length === 0) {
        ctx.ui.notify(`dev-loop: Codex passed on round ${s.round}`, "info");
        s.phase = PHASE.ARCHIVE; s.inner = null; persist(); return "cont";
      }
      if (v.quotaExhausted) {
        s.stopReason = "quota"; interruptedChange = change;
        ctx.ui.notify(`dev-loop: Codex review quota exhausted — stopping (PR + worktree left); use /loop resume after it resets`, "warning");
        persist(); return "stop";
      }
      const sig = suggestionKey(v.suggestions);
      if (s.seenSignatures.includes(sig)) {
        s.stopReason = "repeat"; interruptedChange = change;
        ctx.ui.notify(`dev-loop: round ${s.round} repeats a prior review (fixes not landing); stopping (PR + worktree left)`, "warning");
        persist(); return "stop";
      }
      s.seenSignatures.push(sig);
      s.suggestions = v.suggestions;
      s.inner = REVIEW_INNER.FIX; persist(); return "cont";
    }
    if (s.inner === REVIEW_INNER.TRIGGER) {
      const { code, stderr } = await run(pi, "gh", ["pr", "comment", String(s.prNum), "--body", "@codex review", "--repo", s.repo]);
      if (code !== 0) {
        s.stopReason = "trigger_failed";
        ctx.ui.notify(`dev-loop: trigger @codex review failed: ${stderr}`, "error");
        persist(); return "stop";
      }
      s.triggerAt = await latestCommentAt(pi, s.repo, s.prNum);
      s.reviewDeadline = Date.now() + REVIEW_TOTAL_TIMEOUT_MS;
      s.inner = REVIEW_INNER.WAIT;
      ctx.ui.notify(`dev-loop: round ${s.round} on ${shortSha(s.head)} — polling Codex every ${REVIEW_WAIT_MS / 60000}min (≤${REVIEW_TOTAL_TIMEOUT_MS / 60000}min; touch ${FETCH_SENTINEL} to recheck)…`, "info");
      persist(); return "cont";
    }
    if (s.inner === REVIEW_INNER.WAIT) {
      switch (waitAction(fetchRequested, s.reviewDeadline, Date.now())) {
        case "recheck":
          fetchRequested = false;
          s.inner = REVIEW_INNER.RECONCILE;
          ctx.ui.notify("dev-loop: fetch — rechecking Codex now", "info");
          persist(); return "cont";
        case "timeout":
          s.stopReason = "timeout"; interruptedChange = change;
          ctx.ui.notify(`dev-loop: no Codex review after ${REVIEW_TOTAL_TIMEOUT_MS / 60000}min on round ${s.round}; stopping (PR + worktree left)`, "warning");
          persist(); return "stop";
        default:
          scheduleWait(REVIEW_WAIT_MS);
          return "suspend";
      }
    }
    if (s.inner === REVIEW_INNER.FIX) {
      const { stdout: headPre } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
      await fixPhase(pi, ctx, change, wtDir, s.prNum, s.round, s.suggestions);
      if (stopRequested) {
        s.stopReason = "stopped"; interruptedChange = change;
        ctx.ui.notify(`dev-loop: stopped during fix round ${s.round} — PR + worktree left; use /loop resume`, "warning");
        persist(); return "stop";
      }
      const { stdout: headPost } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
      if (headPre === headPost) {
        s.stopReason = "no_progress"; interruptedChange = change;
        ctx.ui.notify(`dev-loop: agent made no progress on round ${s.round}; stopping (PR + worktree left)`, "warning");
        persist(); return "stop";
      }
      const { code: pushCode, stderr: pushErr } = await run(pi, "git", ["push"], wtDir);
      if (pushCode !== 0) {
        s.stopReason = "push_failed"; interruptedChange = change;
        ctx.ui.notify(`dev-loop: git push failed on round ${s.round} (${pushErr}); stopping — fix then /loop resume`, "error");
        persist(); return "stop";
      }
      s.round++;
      s.inner = REVIEW_INNER.RECONCILE; persist(); return "cont";
    }
    s.stopReason = "bad_state"; persist(); return "stop";
  }

  if (s.phase === PHASE.ARCHIVE) {
    if (existsSync(wtChangeDir)) {
      const { code, stderr } = await run(pi, "openspec", ["archive", change, "-y"], wtDir);
      if (code !== 0) {
        s.stopReason = "archive_failed"; interruptedChange = change;
        ctx.ui.notify(`dev-loop: openspec archive failed: ${stderr}; stopping (PR + worktree left)`, "warning");
        persist(); return "stop";
      }
      const { stdout: dirty } = await run(pi, "git", ["status", "--porcelain"], wtDir);
      if (dirty) {
        await run(pi, "git", ["add", "-A"], wtDir);
        await run(pi, "git", ["commit", "-m", `chore: archive ${change}`], wtDir);
        const { code: pc, stderr: pe } = await run(pi, "git", ["push"], wtDir);
        if (pc !== 0) {
          s.stopReason = "archive_push_failed"; interruptedChange = change;
          ctx.ui.notify(`dev-loop: git push of archive commit failed (${pe}); stopping — fix then /loop resume`, "error");
          persist(); return "stop";
        }
      }
    }
    s.phase = PHASE.MERGE; persist(); return "cont";
  }

  if (s.phase === PHASE.MERGE) {
    const { code, stderr } = await run(pi, "gh", ["pr", "merge", String(s.prNum), "--squash", "--delete-branch", "--repo", s.repo]);
    if (code !== 0) {
      s.stopReason = "merge_failed";
      ctx.ui.notify(`dev-loop: gh pr merge failed: ${stderr}`, "error");
      persist(); return "stop";
    }
    s.phase = PHASE.CLEANUP; persist(); return "cont";
  }

  if (s.phase === PHASE.CLEANUP) {
    await removeWorktree(pi, repoRoot, change);
    return "done";
  }

  s.stopReason = "bad_state"; persist(); return "stop";
}

/** Drive one change from its persisted state to suspension or completion. */
async function driveChange(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  dryRun: boolean
): Promise<"completed" | "suspended" | "stopped" | "aborted"> {
  const repoRoot = ctx.cwd as string;
  let s = readLoopState(repoRoot, change);
  if (!s || s.phase === PHASE.RESOLVE || s.phase === PHASE.PROVISION || s.phase === PHASE.BUILD) {
    const r = await runPrefix(pi, ctx, change, dryRun);
    if (r.kind === "stop") return "stopped";
    if (r.kind === "merged") return "completed";
    if (r.kind !== "atReview") return "aborted";
    s = {
      phase: PHASE.REVIEW, inner: REVIEW_INNER.RECONCILE, round: 1,
      prNum: r.prNum, head: r.head, repo: r.repo,
      triggerAt: null, reviewDeadline: null, seenSignatures: [], suggestions: [], stopReason: null,
    };
    writeLoopState(repoRoot, change, s);
  }
  while (true) {
    if (stopRequested) { s.stopReason = "stopped"; writeLoopState(repoRoot, change, s); return "stopped"; }
    const out = await oneStep(pi, ctx, change, s);
    if (out === "suspend") return "suspended";
    if (out === "done") return "completed";
    if (out === "stop") return "stopped";
    await yieldTick();
  }
}

/** Re-entrant entry. Called by the /loop handler, the review_wait timer, and
 *  /loop fetch. Runs steps (setImmediate yield between them) until the current
 *  change suspends or finishes; for --all, chains the next TODO change. */
async function runLoopChain(): Promise<void> {
  if (!piRef || !runCtx || stepping) return;
  const pi = piRef;
  const ctx = runCtx.ctx;
  stepping = true;
  try {
    while (runCtx) {
      if (stopRequested) {
        interruptedChange = runCtx.change;
        ctx.ui.notify(`dev-loop: stopped (PR + worktree left); use /loop resume`, "warning");
        loopActive = false; stopSentinelTicker(); runCtx = null;
        return;
      }
      const outcome = await driveChange(pi, ctx, runCtx.change, runCtx.dryRun);
      if (outcome === "suspended") return;             // review_wait; timer re-enters
      if (outcome === "completed") {
        if (!runCtx.oneOff) markChangeDone(ctx.cwd as string, runCtx.change);
        clearLoopState(ctx.cwd as string, runCtx.change);
        ctx.ui.notify(`dev-loop: "${runCtx.change}" merged ✅`, "info");
        if (runCtx.all && !runCtx.oneOff) {
          const next = pickTask(ctx.cwd as string);
          if (next) { runCtx = { ...runCtx, change: next.text }; continue; }
        }
        loopActive = false; stopSentinelTicker(); runCtx = null;
        return;
      }
      // stopped / aborted: leave PR + worktree; stop the chain
      if (outcome === "stopped") interruptedChange = runCtx.change;
      loopActive = false; stopSentinelTicker(); runCtx = null;
      return;
    }
  } finally {
    stepping = false;
  }
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
  piRef = pi;
  pi.on("agent_end", () => {
    const r = turnResolve;
    turnResolve = null;
    r && r();
  });

  // loopActive is true across a whole run, including the suspended review_wait
  // window (where the handler has returned and pi is back at its prompt). There,
  // free-text DOES reach this event and is consumed; during an active agent turn
  // (build/fix) it queues instead. The loop's own sendUserMessage calls have
  // source "extension" and pass through unchanged.
  pi.on("input", async (event, ctx) => {
    if (loopActive && event.source === "interactive") {
      ctx.ui.notify("dev-loop is running — use /loop fetch | /loop stop (or touch .dev-loop-fetch / .dev-loop-stop); free-text is ignored", "info");
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
        writeControl(ctx, STOP_SENTINEL, "stop");
        return;
      }
      if (sub === "fetch") {
        writeControl(ctx, FETCH_SENTINEL, "fetch");
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
        runCtx = { ctx, change: ch, dryRun: false, all: false, oneOff: true };
        loopActive = true;
        stopRequested = false;
        clearWaitTimer(ch);
        startSentinelTicker(ctx);
        await runLoopChain();
        return;
      }

      // Normal run: /loop [change] [--dry-run] [--all]. Hand off to the
      // non-blocking driver; it iterates --all itself, suspending across each
      // review_wait via the persisted state + a timer.
      const dryRun = tokens.includes("--dry-run");
      const all = tokens.includes("--all");
      const positional = tokens.filter((t) => !t.startsWith("--"));
      const oneOff = positional.join(" ").trim(); // a change name, run directly
      const cwd = ctx.cwd as string;

      if (!(await checkPreconditions(pi, ctx))) return;

      let firstChange: string | null = null;
      if (oneOff) {
        if (!existsSync(join(cwd, "openspec", "changes", oneOff))) {
          ctx.ui.notify(`dev-loop: change "${oneOff}" not found under openspec/changes/`, "error");
          return;
        }
        firstChange = oneOff;
      } else {
        const t = pickTask(cwd);
        if (!t) {
          ctx.ui.notify("dev-loop: no unchecked `- [ ] <change>` line in TODO.md", "warning");
          return;
        }
        firstChange = t.text;
      }

      runCtx = { ctx, change: firstChange, dryRun, all, oneOff: !!oneOff };
      loopActive = true;
      stopRequested = false;
      clearWaitTimer(firstChange);
      startSentinelTicker(ctx);
      await runLoopChain();
    },
  });
}
