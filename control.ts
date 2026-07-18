import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FETCH_SENTINEL,
  LOOP_STATE_FILE,
  POLL_TICK_MS,
  STOP_SENTINEL,
  WORKTREE_ROOT,
  rt,
} from "./runtime.ts";
import type { LoopCtx, LoopState } from "./runtime.ts";

/** Apply a control signal (fetch/stop). Sets the flag the chain checks, and — if
 *  a loop is running — cancels the review_wait timer and re-enters the chain
 *  (via rt.wakeLoop, so this module doesn't import the pipeline). With the
 *  non-blocking driver, /loop fetch|stop reach here in real time; sentinel files
 *  route through it too for cross-terminal use. */
export function applyControl(ctx: LoopCtx, kind: "fetch" | "stop"): void {
  if (kind === "fetch") rt.fetchRequested = true; else rt.stopRequested = true;
  ctx.ui.notify(
    kind === "stop" ? "dev-loop: stop requested — next safe boundary" : "dev-loop: fetch requested — rechecking now",
    kind === "stop" ? "warning" : "info",
  );
  if (!rt.runCtx) return;
  // Both signals must wake a suspended loop: fetch to re-probe, stop to reach the
  // terminal branch. Clearing the wait timer removes the only other wake source.
  clearWaitTimer(rt.runCtx.change);
  if (!rt.stepping) rt.wakeLoop?.();
}

/** Command path: write the sentinel (cross-terminal trigger) then apply. */
export function writeControl(ctx: LoopCtx, sentinel: string, kind: "fetch" | "stop"): void {
  try { writeFileSync(join(ctx.cwd as string, sentinel), ""); } catch { /* non-fatal */ }
  applyControl(ctx, kind);
}

// --- persisted loop state (.worktree/<change>/.loop-state.json) ----------------
export function statePath(repoRoot: string, change: string): string {
  return join(repoRoot, WORKTREE_ROOT, change, LOOP_STATE_FILE);
}
export function readLoopState(repoRoot: string, change: string): LoopState | null {
  try {
    const p = statePath(repoRoot, change);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as LoopState;
  } catch { return null; }
}
export function writeLoopState(repoRoot: string, change: string, s: LoopState): void {
  const p = statePath(repoRoot, change);
  const tmp = `${p}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, p); } catch { /* resume re-derives */ }
}
export function clearLoopState(repoRoot: string, change: string): void {
  try { unlinkSync(statePath(repoRoot, change)); } catch { /* already gone */ }
}

// --- review_wait timer --------------------------------------------------------
export function clearWaitTimer(change: string): void {
  const t = rt.waitTimers.get(change);
  if (t) { clearTimeout(t); rt.waitTimers.delete(change); }
}
export function scheduleWait(ms: number): void {
  if (!rt.runCtx) return;
  const change = rt.runCtx.change;
  clearWaitTimer(change);
  const t = setTimeout(() => { rt.wakeLoop?.(); }, ms);
  t.unref?.();
  rt.waitTimers.set(change, t);
}

// --- sentinel ticker (cross-terminal control path) ----------------------------
/** 1s ticker that turns a sentinel file (touched from any terminal) into a
 *  control signal — the cross-terminal path, since /loop fetch|stop only work
 *  inside the pi session. Runs only while a loop is active. */
export function startSentinelTicker(ctx: LoopCtx): void {
  stopSentinelTicker();
  rt.sentinelTicker = setInterval(() => {
    if (!rt.runCtx) return;
    const root = ctx.cwd as string;
    const stopP = join(root, STOP_SENTINEL);
    const fetchP = join(root, FETCH_SENTINEL);
    if (existsSync(stopP)) { try { unlinkSync(stopP); } catch { /* gone */ } applyControl(ctx, "stop"); }
    else if (existsSync(fetchP)) { try { unlinkSync(fetchP); } catch { /* gone */ } applyControl(ctx, "fetch"); }
  }, POLL_TICK_MS);
  rt.sentinelTicker.unref?.();
}
export function stopSentinelTicker(): void {
  if (rt.sentinelTicker) { clearInterval(rt.sentinelTicker); rt.sentinelTicker = null; }
}

// --- wake decision (pure, unit-tested) ----------------------------------------
/** WAIT-step decision. Precedence: a fetch request preempts the deadline — an
 *  explicit "recheck now" always re-probes, even if the cap elapsed, instead of
 *  timing out. */
export function waitAction(fetchRequested: boolean, reviewDeadline: number | null, now: number): "recheck" | "timeout" | "wait" {
  if (fetchRequested) return "recheck";
  if (reviewDeadline !== null && now > reviewDeadline) return "timeout";
  return "wait";
}
