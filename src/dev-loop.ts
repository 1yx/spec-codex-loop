import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FETCH_SENTINEL, STOP_SENTINEL, WORKTREE_ROOT, rt, type LoopCtx, type LoopState } from "./runtime.ts";
import { ensureLocalIgnore, findTodoFile, pickTask, removeFromLocalIgnore, run } from "./git-utils.ts";
import { clearWaitTimer, readLoopState, startSentinelTicker, writeControl } from "./control.ts";
import { shortSha } from "./codex.ts";
import { checkPreconditions } from "./phases.ts";
import { runLoopChain } from "./pipeline.ts";

// --- project init (/loop init) ------------------------------------------------
/**
 *
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
  if (existsSync(join(cwd, "openspec"))) {
    ctx.ui.notify("dev-loop: openspec/ already present", "info");
  } else {
    const { code, stderr } = await run(pi, ["openspec", "init", "--tools", "pi"]);
    if (code === 0) {ctx.ui.notify("dev-loop: ran `openspec init --tools pi`", "info");}
    else {ctx.ui.notify(`dev-loop: openspec init failed: ${stderr}`, "error");}
  }
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

/**
 *
 */
function handleStatus(ctx: LoopCtx): void {
  const cwd = ctx.cwd;
  const wtRoot = join(cwd, WORKTREE_ROOT);
  const found: { change: string; s: LoopState }[] = [];
  if (existsSync(wtRoot)) {
    for (const d of readdirSync(wtRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) {continue;}
      const s = readLoopState(cwd, d.name);
      if (s) {found.push({ change: d.name, s });}
    }
  }
  if (!found.length) {
    ctx.ui.notify("dev-loop: no loop state — nothing running, nothing stopped", "info");
    return;
  }
  for (const { change, s } of found) {notifyStatusEntry(ctx, change, s);}
}

/**
 *
 */
async function handleResume(pi: ExtensionAPI, ctx: LoopCtx): Promise<void> {
  if (!rt.interruptedChange) {
    ctx.ui.notify("dev-loop: nothing to resume (no change stopped via /loop stop)", "warning");
    return;
  }
  if (!(await checkPreconditions(pi, ctx))) {return;}
  const ch = rt.interruptedChange;
  ctx.ui.notify(`dev-loop: resuming "${ch}"`, "info");
  rt.runCtx = { ctx, change: ch, dryRun: false, all: false, oneOff: true };
  rt.loopActive = true;
  rt.stopRequested = false;
  rt.fetchRequested = false;
  // Clear stale sentinels left by a touch while no loop was running.
  for (const s of [FETCH_SENTINEL, STOP_SENTINEL]) {
    try { unlinkSync(join(ctx.cwd, s)); } catch { /* already gone */ }
  }
  clearWaitTimer(ch);
  startSentinelTicker(ctx);
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
      ctx.ui.notify("dev-loop: no unchecked `- [ ] <change>` line in TODO.md", "warning");
      return;
    }
    firstChange = t.text;
  }
  rt.runCtx = { ctx, change: firstChange, dryRun, all, oneOff: !!oneOff };
  rt.loopActive = true;
  rt.stopRequested = false;
  clearWaitTimer(firstChange);
  startSentinelTicker(ctx);
  await runLoopChain();
}

/**
 *
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

// --- entry point ---------------------------------------------------------------
/**
 *
 */
export default function (pi: ExtensionAPI): void {
  rt.piRef = pi;
  rt.wakeLoop = runLoopChain; // control/timer trigger the pipeline via this callback (no import cycle)

  pi.on("agent_end", () => {
    const r = rt.turnResolve;
    rt.turnResolve = null;
    r && r();
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
