import { PHASE, REVIEW_INNER } from "./lifecycle-state.ts";
import { isStrategyStopReason } from "./review-circuit-breaker.ts";
import type { LoopState } from "./runtime.ts";

/** Normalize persisted stop/legacy state into a safe re-entry point. */
export function normalizeResumeState(s: LoopState, resumeStopped = false): boolean {
  let changed = false;
  if (!prepareStrategyResume(s, resumeStopped)) {return false;}
  // A stopped PROBE may have been repaired manually with a new pushed HEAD.
  if (s.stopReason && s.phase === PHASE.REVIEW && s.inner === REVIEW_INNER.PROBE) {
    s.inner = REVIEW_INNER.RECONCILE; s.triggerAt = null; s.triggerNonce = null; s.reviewDeadline = null;
    changed = true;
  }
  // Legacy FIX states omitted suggestions; re-probe without tripping repeat.
  if (s.phase === PHASE.REVIEW && s.inner === REVIEW_INNER.FIX && s.suggestions.length === 0) {
    s.inner = REVIEW_INNER.RECONCILE;
    s.seenSignatures.pop();
    changed = true;
  }
  if (s.stopReason) {s.stopReason = null; s.stopSummary = null; changed = true;}
  return changed;
}

/** Refuse strategy stops unless the caller explicitly used the resume command. */
function prepareStrategyResume(s: LoopState, resumeStopped: boolean): boolean {
  if (!isStrategyStopReason(s.stopReason)) {return true;}
  if (!resumeStopped) {return false;}
  s.strategyEpoch++;
  return true;
}
