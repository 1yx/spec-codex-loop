import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILD_INNER, PHASE, REVIEW_INNER, isPhase, type Phase } from "./lifecycle-state.ts";
import {
  FETCH_SENTINEL,
  LOOP_STATE_FILE,
  LOOP_LOCK_FILE,
  POLL_TICK_MS,
  STOP_SENTINEL,
  WORKTREE_ROOT,
  rt,
  type LoopCtx,
  type LoopState,
  type Suggestion,
} from "./runtime.ts";

const BUILD_INNERS: ReadonlySet<string> = new Set(Object.values(BUILD_INNER));
const REVIEW_INNERS: ReadonlySet<string> = new Set(Object.values(REVIEW_INNER));

/** Apply a control signal (fetch/stop). Sets the flag the chain checks, and — if
 *  a loop is running — cancels the review_wait timer and re-enters the chain
 *  (via rt.wakeLoop, so this module doesn't import the pipeline). With the
 *  non-blocking driver, /loop fetch|stop reach here in real time; sentinel files
 *  route through it too for cross-terminal use. */
export function applyControl(ctx: LoopCtx, kind: "fetch" | "stop"): void {
  if (kind === "fetch") {rt.fetchRequested = true;} else {rt.stopRequested = true;}
  ctx.ui.notify(
    kind === "stop" ? "dev-loop: 已请求停止 — 将在下一个安全边界生效" : "dev-loop: fetch requested — rechecking now",
    "info",
  );
  if (!rt.runCtx) {return;}
  // Both signals must wake a suspended loop: fetch to re-probe, stop to reach the
  // terminal branch. Clearing the wait timer removes the only other wake source.
  clearWaitTimer(rt.runCtx.change);
  if (!rt.stepping) {void rt.wakeLoop?.();}
}

/** Command path: write the sentinel (cross-terminal trigger) then apply. */
export function writeControl(ctx: LoopCtx, sentinel: string, kind: "fetch" | "stop"): void {
  try { writeFileSync(join(ctx.cwd, sentinel), ""); } catch { /* non-fatal */ }
  applyControl(ctx, kind);
}

// --- persisted loop state (.worktree/<change>/.loop-state.json) ----------------
/**
 * Path to a change's persisted loop-state file.
 */
export function statePath(repoRoot: string, change: string): string {
  return join(repoRoot, WORKTREE_ROOT, change, LOOP_STATE_FILE);
}
/**
 * Read a change's persisted loop state, or null if absent/corrupt.
 */
export function readLoopState(repoRoot: string, change: string): LoopState | null {
  try {
    const p = statePath(repoRoot, change);
    if (!existsSync(p)) {return null;}
    return normalizeLoopState(JSON.parse(readFileSync(p, "utf-8")));
  } catch { return null; }
}

/** Validate current state files and fill fields omitted by older versions. */
function normalizeLoopState(value: unknown): LoopState | null {
  if (!value || typeof value !== "object") {return null;}
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (typeof raw.phase !== "string" || !isPhase(raw.phase)) {return null;}
  return {
    phase: raw.phase,
    inner: normalizeInner(raw.phase, raw.inner),
    round: numberOr(raw.round, 0),
    prNum: numberOr(raw.prNum, 0),
    head: stringOr(raw.head, ""),
    repo: stringOr(raw.repo, ""),
    triggerAt: nullableString(raw.triggerAt, null),
    triggerNonce: nullableString(raw.triggerNonce, null),
    reviewDeadline: nullableNumber(raw.reviewDeadline),
    seenSignatures: stringArray(raw.seenSignatures),
    suggestions: suggestionArray(raw.suggestions),
    agentHead: nullableString(raw.agentHead, null),
    stopReason: nullableString(raw.stopReason, null),
    oneOff: typeof raw.oneOff === "boolean" && raw.oneOff,
  };
}

/** Repair a missing or unknown phase-specific inner state to its safe entry point. */
function normalizeInner(phase: Phase, value: unknown): string | null {
  if (phase === PHASE.BUILD) {
    return typeof value === "string" && BUILD_INNERS.has(value) ? value : BUILD_INNER.IMPLEMENT;
  }
  if (phase === PHASE.REVIEW) {
    return typeof value === "string" && REVIEW_INNERS.has(value) ? value : REVIEW_INNER.RECONCILE;
  }
  return null;
}

/** Check one persisted review suggestion. */
function isSuggestion(value: unknown): value is Suggestion {
  if (!value || typeof value !== "object") {return false;}
  const raw: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (raw.severity === null || typeof raw.severity === "string")
    && typeof raw.title === "string" && typeof raw.body === "string"
    && (raw.path === null || typeof raw.path === "string")
    && (raw.line === null || typeof raw.line === "number");
}

const stringOr = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;
const numberOr = (value: unknown, fallback: number): number => typeof value === "number" ? value : fallback;
const nullableString = (value: unknown, fallback: string | null): string | null => {
  if (value === null) {return null;}
  return typeof value === "string" ? value : fallback;
};
const nullableNumber = (value: unknown): number | null => typeof value === "number" ? value : null;
const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const suggestionArray = (value: unknown): Suggestion[] => Array.isArray(value) ? value.filter(isSuggestion) : [];
/**
 * Persist a change's loop state (atomic temp-file rename).
 */
export function writeLoopState(repoRoot: string, change: string, s: LoopState): void {
  const p = statePath(repoRoot, change);
  const tmp = `${p}.tmp`;
  // Suggestions are required to resume an interrupted FIX agent turn. Outside
  // FIX they are ephemeral and omitted so later states cannot reuse a stale verdict.
  const persisted = s.phase === "review" && s.inner === "review_fix" ? s : { ...s, suggestions: undefined };
  try { writeFileSync(tmp, JSON.stringify(persisted)); renameSync(tmp, p); } catch { /* resume re-derives */ }
}
/**
 * Delete a change's persisted loop state (after a clean merge).
 */
export function clearLoopState(repoRoot: string, change: string): void {
  try { unlinkSync(statePath(repoRoot, change)); } catch { /* already gone */ }
}

/** Acquire the project-wide loop lock, reclaiming a dead process's lock. */
export function acquireLoopLock(ctx: LoopCtx): boolean {
  const path = join(ctx.cwd, LOOP_LOCK_FILE);
  if (rt.loopLockPath === path) {return false;}
  const db = acquireLockDatabase(ctx, path);
  if (!db) {return false;}
  const owner = readLockOwner(path);
  if (owner.pid !== null && owner.pid !== process.pid && isProcessAlive(owner.pid)) {
    ctx.ui.notify(`dev-loop: another process (${owner.pid}) owns ${LOOP_LOCK_FILE}`, "warning");
    closeLockDatabase(db);
    return false;
  }
  try {
    unlinkSync(path);
  } catch { /* absent legacy/stale owner */ }
  try {
    unlinkSync(`${path}.reclaim`);
  } catch { /* legacy recovery guard is no longer authoritative */ }
  try {
    createLoopLock(path);
    rt.loopLockDb = db;
    return true;
  } catch {
    closeLockDatabase(db);
    ctx.ui.notify(`dev-loop: cannot create ${LOOP_LOCK_FILE}`, "error");
    return false;
  }
}

/** Acquire an OS-backed transaction that is released automatically on crash. */
function acquireLockDatabase(ctx: LoopCtx, ownerPath: string): DatabaseSync | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(`${ownerPath}.sqlite`);
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    return db;
  } catch {
    if (db) {try {db.close();} catch { /* already closed */ }}
    const owner = readLockOwner(ownerPath);
    const detail = owner.pid === null ? "another process" : `process ${owner.pid}`;
    ctx.ui.notify(`dev-loop: ${detail} owns ${LOOP_LOCK_FILE}`, "warning");
    return null;
  }
}

/** Release the SQLite transaction without masking the caller's cleanup path. */
function closeLockDatabase(db: { exec(sql: string): void; close(): void }): void {
  try {db.exec("ROLLBACK;");} catch { /* transaction may already be gone */ }
  try {db.close();} catch { /* already closed */ }
}

/** Atomically create and record ownership of a repository lock. */
function createLoopLock(path: string): true {
  const fd = openSync(path, "wx");
  const token = randomUUID();
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Temporal.Now.instant().toString() }));
  } catch (error) {
    try {unlinkSync(path);} catch { /* best effort */ }
    throw error;
  } finally {closeSync(fd);}
  rt.loopLockPath = path;
  rt.loopLockToken = token;
  return true;
}

/** Parsed identity recorded in a repository lock file. */
type LockOwner = { pid: number | null; token: string | null };

/** Read an existing lock owner; malformed lock files have no owner. */
function readLockOwner(path: string): LockOwner {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      pid: typeof raw.pid === "number" ? raw.pid : null,
      token: typeof raw.token === "string" ? raw.token : null,
    };
  } catch {return { pid: null, token: null };}
}

/** Probe process liveness without sending a signal. */
function isProcessAlive(pid: number): boolean {
  try {process.kill(pid, 0); return true;} catch {return false;}
}

/** Release the project lock owned by this runtime. */
export function releaseLoopLock(): void {
  if (!rt.loopLockPath) {return;}
  const owner = readLockOwner(rt.loopLockPath);
  if (owner.token !== null && owner.token === rt.loopLockToken) {
    try {unlinkSync(rt.loopLockPath);} catch { /* already gone */ }
  }
  if (rt.loopLockDb) {closeLockDatabase(rt.loopLockDb);}
  rt.loopLockPath = null;
  rt.loopLockToken = null;
  rt.loopLockDb = null;
}

// --- review_wait timer --------------------------------------------------------
/**
 * Cancel a change's pending review_wait timer, if any.
 */
export function clearWaitTimer(change: string): void {
  const t = rt.waitTimers.get(change);
  if (t) { clearTimeout(t); rt.waitTimers.delete(change); }
}
/**
 * Schedule a review_wait re-probe after `ms`; replaces any pending timer for the run's change.
 */
export function scheduleWait(ms: number): void {
  if (!rt.runCtx) {return;}
  const change = rt.runCtx.change;
  clearWaitTimer(change);
  const t = setTimeout(() => {
    if (rt.waitTimers.get(change) !== t || rt.runCtx?.change !== change) {return;}
    rt.waitTimers.delete(change);
    void rt.wakeLoop?.();
  }, ms);
  t.unref?.();
  rt.waitTimers.set(change, t);
}

// --- sentinel ticker (cross-terminal control path) ----------------------------
/** 1s ticker that turns a sentinel file (touched from any terminal) into a
 *  control signal — the cross-terminal path, since /loop fetch|stop only work
 *  inside the pi session. Runs only while a loop is active. */
export function startSentinelTicker(ctx: LoopCtx): void {
  stopSentinelTicker();
  rt.sentinelTicker = setInterval(() => pollSentinels(ctx), POLL_TICK_MS);
  rt.sentinelTicker.unref?.();
}

/** Process one deterministic sentinel tick. Stop wins when both files exist. */
export function pollSentinels(ctx: LoopCtx): void {
  if (!rt.runCtx) {return;}
  const stopP = join(ctx.cwd, STOP_SENTINEL);
  const fetchP = join(ctx.cwd, FETCH_SENTINEL);
  if (existsSync(stopP)) {
    for (const path of [stopP, fetchP]) {try {unlinkSync(path);} catch { /* gone */ }}
    applyControl(ctx, "stop");
  }
  else if (existsSync(fetchP)) { try { unlinkSync(fetchP); } catch { /* gone */ } applyControl(ctx, "fetch"); }
}
/**
 * Stop the cross-terminal sentinel ticker.
 */
export function stopSentinelTicker(): void {
  if (rt.sentinelTicker) { clearInterval(rt.sentinelTicker); rt.sentinelTicker = null; }
}

// --- wake decision (pure, unit-tested) ----------------------------------------
/** WAIT-step decision. Precedence: a fetch request preempts the deadline — an
 *  explicit "recheck now" always re-probes, even if the cap elapsed, instead of
 *  timing out. */
export function waitAction(fetchRequested: boolean, reviewDeadline: number | null, now: number): "recheck" | "timeout" | "wait" {
  if (fetchRequested) {return "recheck";}
  if (reviewDeadline !== null && now >= reviewDeadline) {return "timeout";}
  return "wait";
}
