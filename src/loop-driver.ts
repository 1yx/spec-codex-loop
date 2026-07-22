import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearLoopState, clearWaitTimer, readLoopState, releaseLoopLock, stopSentinelTicker, writeLoopState } from "./control.ts";
import { pickTask } from "./git-utils.ts";
import { driveChange } from "./pipeline.ts";
import { rt, type LoopCtx } from "./runtime.ts";

/** Finish one change and select the next --all task when present. */
function handleCompleted(ctx: LoopCtx): "chain" | "done" {
  const change = rt.runCtx?.change ?? "";
  clearLoopState(ctx.cwd, change);
  ctx.ui.notify(`dev-loop: "${change}" merged ✅`, "info");
  if (rt.runCtx?.all && !rt.runCtx.oneOff) {
    const next = pickTask(ctx.cwd);
    if (next) {rt.runCtx = { ...rt.runCtx, change: next.text }; return "chain";}
  }
  endChain(change, false);
  return "done";
}

/** Tear down one chain and release every process-local control resource. */
function endChain(change: string, stopped: boolean): void {
  if (stopped) {rt.interruptedChange = change;}
  clearWaitTimer(change);
  rt.loopActive = false;
  stopSentinelTicker();
  rt.runCtx = null;
  releaseLoopLock();
}

/** Drive active changes until suspension or a terminal outcome. */
async function driveActiveChain(pi: ExtensionAPI, ctx: LoopCtx): Promise<void> {
  while (rt.runCtx) {
    if (rt.stopRequested) {
      const change = rt.runCtx.change;
      const state = readLoopState(ctx.cwd, change);
      if (state) {state.stopReason = "stopped"; writeLoopState(ctx.cwd, change, state);}
      ctx.ui.notify(`dev-loop: stopped (PR + worktree left); use /loop resume`, "info");
      endChain(change, true);
      return;
    }
    const outcome = await driveChange(pi, ctx, rt.runCtx.change);
    if (outcome === "suspended") {return;}
    if (outcome === "completed") {
      if (handleCompleted(ctx) === "chain") {continue;}
      return;
    }
    endChain(rt.runCtx.change, outcome === "stopped");
    return;
  }
}

/** Re-entrant driver called by commands, timers, and control signals. */
export async function runLoopChain(): Promise<void> {
  if (!rt.piRef || !rt.runCtx || rt.stepping) {return;}
  const pi = rt.piRef;
  const ctx = rt.runCtx.ctx;
  rt.stepping = true;
  try {
    await driveActiveChain(pi, ctx);
  } catch (error) {
    const change = rt.runCtx?.change;
    if (change) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`dev-loop: unexpected failure in "${change}" (${message}); state kept for /loop resume`, "error");
      endChain(change, true);
    }
    throw error;
  } finally {
    rt.stepping = false;
  }
}
