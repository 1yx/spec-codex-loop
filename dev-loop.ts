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
 *   /loop <change>        run one specific change (not from TODO.md)
 *   /loop --dry-run       build phase only; skip push/PR/review/archive/merge
 *   /loop --all           keep pulling changes from TODO.md until none left
 *   /loop --max-rounds N  optional circuit breaker on review rounds (default: unbounded)
 *
 * The OUTER loop is deterministic TS (can't drift). The fuzzy work (implement,
 * address review) is delegated to pi's agent, one bounded turn at a time, each
 * told to work inside the change's worktree.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_LOGIN = "chatgpt-codex-connector"; // bot login prefix; API may append "[bot]"
const PASS_RE = /Didn't find any major issues/i;
const DEFAULT_MAX_ROUNDS = Infinity; // default: no cap; `--max-rounds N` sets an optional circuit breaker
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
  suggestions: Suggestion[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Remove a change's worktree + its local branch. Best-effort. */
async function removeWorktree(pi: ExtensionAPI, repoRoot: string, change: string) {
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  await run(pi, "git", ["worktree", "remove", "--force", wtDir], repoRoot);
  await run(pi, "git", ["branch", "-D", change], repoRoot);
}

async function resolveRepo(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const { stdout } = await run(pi, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot);
  return stdout || "";
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

/** True once `openspec archive` has moved the change out of openspec/changes/. */
function isArchived(wtDir: string, change: string): boolean {
  return !existsSync(join(wtDir, "openspec", "changes", change));
}

// --- agent drive: one listener, no accumulation --------------------------------
let turnResolve: (() => void) | null = null;

function driveAgent(pi: ExtensionAPI, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    turnResolve = resolve;
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
  user?: { login: string };
  state: string;
  submitted_at: string;
  commit_id?: string;
  body?: string;
}
interface GhInlineComment extends GhComment {
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

async function awaitCodexReview(
  pi: ExtensionAPI,
  ctx: any,
  repo: string,
  prNum: number,
  since: string
): Promise<PollResult> {
  // Poll every REVIEW_WAIT_MS; retry on empty until REVIEW_TOTAL_TIMEOUT_MS.
  const deadline = Date.now() + REVIEW_TOTAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(REVIEW_WAIT_MS);

    const comments = (await ghJson<GhComment[]>(
      pi,
      `repos/${repo}/issues/${prNum}/comments`
    )) ?? [];
    const freshComments = comments.filter((c) => isCodex(c.user?.login) && c.created_at > since);
    if (freshComments.some((c) => PASS_RE.test(c.body))) {
      return { pass: true, timeout: false, suggestions: [] };
    }

    const reviews = (await ghJson<GhReview[]>(
      pi,
      `repos/${repo}/pulls/${prNum}/reviews`
    )) ?? [];
    const failReview = reviews.find(
      (r) => isCodex(r.user?.login) && r.submitted_at > since
    );
    if (failReview) {
      const inline = (await ghJson<GhInlineComment[]>(
        pi,
        `repos/${repo}/pulls/${prNum}/comments`
      )) ?? [];
      const suggestions = inline
        .filter((c) => isCodex(c.user?.login) && c.created_at > since)
        .map(parseSuggestion)
        .filter((s) => s.title);
      return { pass: false, timeout: false, suggestions };
    }

    // Nothing yet — retry after another interval (unless the cap is reached).
    if (Date.now() < deadline) {
      ctx.ui.notify(
        `dev-loop: no Codex review yet; retrying in ${REVIEW_WAIT_MS / 60000}min…`,
        "info"
      );
    }
  }
  return { pass: false, timeout: true, suggestions: [] };
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

// --- per-change pipeline -------------------------------------------------------
async function runTask(
  pi: ExtensionAPI,
  ctx: any,
  change: string,
  opts: { dryRun: boolean; maxRounds: number }
): Promise<boolean> {
  const repoRoot = ctx.cwd as string;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);

  ctx.ui.notify(`dev-loop: change → ${change} (worktree ${wtDir})`, "info");

  await ensureLocalIgnore(pi, repoRoot, `${WORKTREE_ROOT}/`);

  // Resolve repo + detect prior-run state (for resume).
  const repo = await resolveRepo(pi, repoRoot);
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

  // Ensure the openspec change is present in the worktree.
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (!existsSync(wtChangeDir)) {
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
  if (opts.dryRun) {
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
  const seenSignatures: string[] = [];
  for (let round = 1; round <= opts.maxRounds; round++) {
    const since = new Date().toISOString();
    const { code: trigCode, stderr: trigErr } = await run(pi, "gh", [
      "pr", "comment", String(prNum), "--body", "@codex review", "--repo", repo,
    ]);
    if (trigCode !== 0) {
      ctx.ui.notify(`dev-loop: trigger @codex review failed: ${trigErr}`, "error");
      return false;
    }
    ctx.ui.notify(
      `dev-loop: round ${round} — polling Codex every ${REVIEW_WAIT_MS / 60000}min (≤${REVIEW_TOTAL_TIMEOUT_MS / 60000}min)…`,
      "info"
    );
    const result = await awaitCodexReview(pi, ctx, repo, prNum, since);

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
    const { stdout: headPost } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
    if (headPre === headPost) {
      ctx.ui.notify(`dev-loop: agent made no progress on round ${round}; stopping (PR + worktree left)`, "warning");
      return false;
    }
    await run(pi, "git", ["push"], wtDir);
    if (round === opts.maxRounds) {
      ctx.ui.notify(
        `dev-loop: hit max-rounds (${opts.maxRounds}) without Codex pass; stopping (PR + worktree left)`,
        "warning"
      );
      return false;
    }
  }

  // Archive the change (fold specs into openspec/specs, move to archive/). Idempotent on resume.
  if (!isArchived(wtDir, change)) {
    const { code: arcCode, stderr: arcErr } = await run(pi, "openspec", ["archive", change, "-y"], wtDir);
    if (arcCode !== 0) {
      ctx.ui.notify(`dev-loop: openspec archive failed: ${arcErr}; stopping (PR + worktree left)`, "warning");
      return false;
    }
    const { stdout: dirty } = await run(pi, "git", ["status", "--porcelain"], wtDir);
    if (dirty) {
      await run(pi, "git", ["add", "-A"], wtDir);
      await run(pi, "git", ["commit", "-m", `chore: archive ${change}`], wtDir);
      await run(pi, "git", ["push"], wtDir);
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

  pi.registerCommand("loop", {
    description:
      "Autonomous OpenSpec-change → worktree → PR → Codex review → archive → merge loop. Flags: --dry-run --all --max-rounds N",
    handler: async (args, ctx) => {
      const argv = String(args ?? "").trim();
      const tokens = argv.split(/\s+/).filter(Boolean);
      if (tokens[0] === "init") {
        await initProject(pi, ctx);
        return;
      }
      const dryRun = tokens.includes("--dry-run");
      const all = tokens.includes("--all");
      const mrIdx = tokens.indexOf("--max-rounds");
      const maxRounds = mrIdx >= 0 ? parseInt(tokens[mrIdx + 1] ?? "", 10) || DEFAULT_MAX_ROUNDS : DEFAULT_MAX_ROUNDS;
      const positional = tokens.filter((t) => !t.startsWith("--") && t !== tokens[mrIdx + 1]);
      const oneOff = positional.join(" ").trim(); // a change name, run directly

      const cwd = ctx.cwd as string;

      // Preconditions.
      for (const cmd of ["git", "gh", "openspec"]) {
        const { code } = await run(pi, "sh", ["-c", `command -v ${cmd}`]);
        if (code !== 0) {
          ctx.ui.notify(`dev-loop: required command missing: ${cmd}`, "error");
          return;
        }
      }
      const { code: osDir } = await run(pi, "sh", ["-c", `test -d openspec`]);
      if (osDir !== 0) {
        ctx.ui.notify("dev-loop: no openspec/ dir — run `/loop init` first", "error");
        return;
      }

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
          item = { text: oneOff, lineNo: null };
        } else {
          const t = pickTask(cwd);
          item = t ? { text: t.text, lineNo: t.lineNo } : null;
        }
        if (!item) {
          ctx.ui.notify("dev-loop: no more changes", "info");
          break;
        }
        const merged = await runTask(pi, ctx, item.text, { dryRun, maxRounds });
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
