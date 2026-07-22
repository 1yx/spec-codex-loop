import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FETCH_SENTINEL, LOOP_LOCK_FILE, STOP_SENTINEL, WORKTREE_ROOT, rt, type LoopCtx, type LoopState } from "./runtime.ts";
import { ensureLocalIgnore, findTodoFile, pickTask, removeFromLocalIgnore, run } from "./git-utils.ts";
import { acquireLoopLock, clearWaitTimer, readLoopState, startSentinelTicker, writeControl } from "./control.ts";
import { shortSha } from "./codex.ts";
import { checkPreconditions } from "./phases.ts";
import { runLoopChain } from "./pipeline.ts";

// --- project init (/loop init) ------------------------------------------------
/** Commit newly-created loop artifacts so future worktrees inherit them. */
async function trackInitArtifacts(pi: ExtensionAPI, ctx: LoopCtx, todoPath: string): Promise<void> {
  const cwd = ctx.cwd;
  const todoRel = relative(cwd, todoPath);
  const { stdout: todoTracked } = await run(pi, ["git", "ls-files", "--", todoRel], cwd);
  const { stdout: osTracked } = await run(pi, ["git", "ls-files", "--", "openspec/"], cwd);
  const added: string[] = [];
  if (!todoTracked.trim()) {await run(pi, ["git", "add", todoRel], cwd); added.push(todoRel);}
  if (existsSync(join(cwd, "openspec")) && !osTracked.trim()) {await run(pi, ["git", "add", "openspec/"], cwd); added.push("openspec/");}
  if (added.length === 0) {return;}
  const commit = await run(pi, ["git", "commit", "-m", "chore: initialize spec-codex-loop"], cwd);
  if (commit.code !== 0) {return;}
  const push = await run(pi, ["git", "push", "origin", "main"], cwd);
  ctx.ui.notify(push.code === 0 ? `dev-loop: committed + pushed ${added.join(" + ")} to main` : `dev-loop: initialization committed locally but push failed (${push.stderr})`, push.code === 0 ? "info" : "warning");
}

/**
 * `/loop init`: create TODO.md, git-ignore .worktree/, scaffold openspec.
 */
async function initProject(pi: ExtensionAPI, ctx: LoopCtx): Promise<void> {
  const cwd = ctx.cwd;
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
  await removeFromLocalIgnore(pi, cwd, "TODO.md");
  await ensureLocalIgnore(pi, cwd, `${WORKTREE_ROOT}/`);
  await ensureLocalIgnore(pi, cwd, LOOP_LOCK_FILE);
  if (existsSync(join(cwd, "openspec"))) {
    ctx.ui.notify("dev-loop: openspec/ already present", "info");
  } else {
    const { code, stderr } = await run(pi, ["openspec", "init", "--tools", "pi"]);
    if (code === 0) {ctx.ui.notify("dev-loop: ran `openspec init --tools pi`", "info");}
    else {ctx.ui.notify(`dev-loop: openspec init failed: ${stderr}`, "error");}
  }
  await trackInitArtifacts(pi, ctx, todoPath);
}

// --- /loop subcommand handlers ------------------------------------------------
/** Read-only snapshot of every persisted loop state. Scans disk (not the
 *  in-memory interruptedChange) so it still finds a change left stuck by a
 *  crash/restart — which is the whole reason stopReason is persisted. */
function notifyStatusEntry(ctx: LoopCtx, change: string, s: LoopState): void {
  const running = rt.loopActive && rt.runCtx?.change === change;
  const tag = running ? "RUNNING" : s.stopReason ? `STOPPED (${s.stopReason})` : "idle";
  ctx.ui.notify(
    `dev-loop: "${change}" — ${tag}\n` +
    `  phase ${s.phase}${s.inner ? ` / inner ${s.inner}` : ""} · round ${s.round}\n` +
    `  PR #${s.prNum} @ ${shortSha(s.head)} (${s.repo})`,
    running ? "info" : s.stopReason ? "warning" : "info",
  );
}

/** Scan .worktree/ subdirs for persisted loop states (running or stopped). */
function scanLoopStates(cwd: string): { change: string; s: LoopState }[] {
  const wtRoot = join(cwd, WORKTREE_ROOT);
  const found: { change: string; s: LoopState }[] = [];
  if (existsSync(wtRoot)) {
    for (const d of readdirSync(wtRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) {continue;}
      const s = readLoopState(cwd, d.name);
      if (s) {found.push({ change: d.name, s });}
    }
  }
  return found;
}

/**
 * `/loop status`: scan every persisted loop state and report phase/inner/round/PR + stop reason.
 */
function handleStatus(ctx: LoopCtx): void {
  const found = scanLoopStates(ctx.cwd);
  if (!found.length) {
    ctx.ui.notify("dev-loop: no loop state — nothing running, nothing stopped", "info");
    return;
  }
  for (const { change, s } of found) {notifyStatusEntry(ctx, change, s);}
}

/** Claim this repository before exposing an active runtime to async callbacks. */
function beginRun(ctx: LoopCtx, runCtx: NonNullable<typeof rt.runCtx>): boolean {
  if (rt.loopActive) {
    ctx.ui.notify(`dev-loop: already running "${rt.runCtx?.change ?? "unknown"}"`, "warning");
    return false;
  }
  if (!acquireLoopLock(ctx)) {return false;}
  rt.runCtx = runCtx;
  rt.loopActive = true;
  rt.stopRequested = false;
  rt.fetchRequested = false;
  clearWaitTimer(runCtx.change);
  startSentinelTicker(ctx);
  return true;
}

/**
 * `/loop resume`: re-enter the change last stopped via `/loop stop`.
 */
async function handleResume(pi: ExtensionAPI, ctx: LoopCtx): Promise<void> {
  let ch = rt.interruptedChange;
  if (!ch) {
    // Prefer explicit stopped states. If none exist, a unique persisted state
    // is a crash-recovery candidate (the process may have died before writing a stopReason).
    const found = scanLoopStates(ctx.cwd);
    const stopped = found.filter((x) => x.s.stopReason);
    const candidates = stopped.length > 0 ? stopped : found;
    if (candidates.length === 0) {
      ctx.ui.notify("dev-loop: nothing to resume (no persisted loop state)", "info");
      return;
    }
    if (candidates.length > 1) {
      ctx.ui.notify(`dev-loop: multiple resumable changes (${candidates.map((x) => x.change).join(", ")}); specify one with /loop <change>`, "info");
      return;
    }
    ch = candidates[0].change;
    ctx.ui.notify(`dev-loop: interruptedChange lost on restart — resuming "${ch}" from disk state`, "info");
  }
  if (!(await checkPreconditions(pi, ctx))) {return;}
  ctx.ui.notify(`dev-loop: resuming "${ch}"`, "info");
  const runCtx = { ctx, change: ch, dryRun: false, all: false, oneOff: true };
  if (!beginRun(ctx, runCtx)) {return;}
  // Clear stale sentinels left by a touch while no loop was running.
  for (const s of [FETCH_SENTINEL, STOP_SENTINEL]) {
    try { unlinkSync(join(ctx.cwd, s)); } catch { /* already gone */ }
  }
  await runLoopChain();
}

/** Normal run: /loop [change] [--dry-run] [--all]. */
async function handleNormalRun(pi: ExtensionAPI, ctx: LoopCtx, tokens: string[]): Promise<void> {
  const dryRun = tokens.includes("--dry-run");
  const all = tokens.includes("--all");
  const positional = tokens.filter((t) => !t.startsWith("--"));
  const oneOff = positional.join(" ").trim();
  const cwd = ctx.cwd;
  if (!(await checkPreconditions(pi, ctx))) {return;}
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
      ctx.ui.notify("dev-loop: no unchecked `- [ ] <change>` line in TODO.md", "info");
      return;
    }
    firstChange = t.text;
  }
  const runCtx = { ctx, change: firstChange, dryRun, all, oneOff: !!oneOff };
  if (!beginRun(ctx, runCtx)) {return;}
  await runLoopChain();
}

/**
 * Dispatch `/loop` subcommands: init | stop | fetch | status | resume, else a normal run.
 */
async function loopCommandHandler(pi: ExtensionAPI, args: unknown, ctx: LoopCtx): Promise<void> {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0];
  if (sub === "init") {return initProject(pi, ctx);}
  if (sub === "stop") {return writeControl(ctx, STOP_SENTINEL, "stop");}
  if (sub === "fetch") {return writeControl(ctx, FETCH_SENTINEL, "fetch");}
  if (sub === "status") {return handleStatus(ctx);}
  if (sub === "resume") {return handleResume(pi, ctx);}
  return handleNormalRun(pi, ctx, tokens);
}

/**
 * Extension entry: wire agent_end/input listeners and register the `/loop` command.
 */
export default function (pi: ExtensionAPI): void {
  rt.piRef = pi;
  rt.wakeLoop = runLoopChain; // control/timer trigger the pipeline via this callback (no import cycle)

  pi.on("agent_end", (event: AgentEndEvent) => {
    const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") {
      rt.turnResult = { ok: false, error: "agent ended without an assistant result" };
      return;
    }
    const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
    rt.turnResult = { ok: !failed, error: failed ? assistant.errorMessage ?? assistant.stopReason : null };
  });

  // agent_end may be followed by an automatic retry. Only advance the state
  // machine after agent_settled confirms that no retry/continuation remains.
  pi.on("agent_settled", () => {
    const r = rt.turnResolve;
    if (!r) {return;}
    rt.turnResolve = null;
    r(rt.turnResult ?? { ok: false, error: "agent settled without a result" });
  });

  // loopActive is true across a whole run, including the suspended review_wait
  // window (handler returned, pi back at its prompt). Free-text reaches this
  // event there; during an active agent turn it queues instead.
  pi.on("input", (event: { source: string }, ctx: LoopCtx) => {
    if (rt.loopActive && event.source === "interactive") {
      ctx.ui.notify("dev-loop is running — use /loop fetch | /loop stop (or touch .dev-loop-fetch / .dev-loop-stop); free-text is ignored", "info");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.registerCommand("loop", {
    description:
      "Autonomous OpenSpec-change → worktree → PR → Codex review → archive → merge loop. Subcommands: stop | fetch | resume | status. Flags: --dry-run --all",
    handler: (args: unknown, ctx: LoopCtx) => loopCommandHandler(pi, args, ctx),
  });
}
