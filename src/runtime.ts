import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- cross-cutting constants --------------------------------------------------
export const FETCH_SENTINEL = ".dev-loop-fetch";
export const STOP_SENTINEL = ".dev-loop-stop";
export const LOOP_STATE_FILE = ".loop-state.json";
export const WORKTREE_ROOT = ".worktree";
export const POLL_TICK_MS = 1000;
export const REVIEW_WAIT_MS = 10 * 60_000; // poll interval between Codex fetches
export const REVIEW_TOTAL_TIMEOUT_MS = 30 * 60_000; // cap per round

// --- cross-cutting types ------------------------------------------------------
/**
 *
 */
export type Suggestion = {
  severity: string | null;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}

/**
 *
 */
export type PollResult = {
  pass: boolean;
  timeout: boolean;
  stopped: boolean;
  quotaExhausted: boolean;
  /** Codex posted after our trigger but we couldn't classify it as
   *  pass/quota/suggestions (e.g. a bot "Something went wrong" error). Distinct
   *  from a null return (Codex hasn't spoken at all) so the caller re-triggers
   *  instead of waiting out the timeout on a dead trigger. */
  unclassified: boolean;
  suggestions: Suggestion[];
}

/**
 *
 */
export type LoopState = {
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
  oneOff: boolean;
}

/**
 *
 */
export type ReconcileResult =
  | { kind: "ok"; head: string }
  | { kind: "diverged" }
  | { kind: "sync_push_failed"; stderr: string }
  | { kind: "main_merged_clean"; head: string }
  | { kind: "main_conflict" };

/**
 *
 */
export type RunCtx = {
  ctx: LoopCtx;
  change: string;
  dryRun: boolean;
  all: boolean;
  oneOff: boolean;
};

/** The slice of pi's ExtensionContext the loop actually uses (the full type lives
 *  in the unresolvable-at-lint-time \@earendil-works/pi-coding-agent package, so
 *  we declare the minimal structural shape to avoid `any`). */
export type LoopCtx = {
  cwd: string;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

/** Bundle of "what an agent phase operates on" — keeps function signatures
 *  under the lint param cap without threading pi/ctx/change/wtDir separately. */
export type PhaseCtx = {
  pi: ExtensionAPI;
  ctx: LoopCtx;
  change: string;
  wtDir: string;
}

/** oneStep handler context: a PhaseCtx plus the persisted state + persist fn. */
export type StepCtx = {
  s: LoopState;
  persist: () => void;
} & PhaseCtx

// --- shared mutable runtime state (singleton; imported + mutated across modules) ---
/**
 *
 */
type RtState = {
  piRef: ExtensionAPI | null;
  runCtx: RunCtx | null;
  loopActive: boolean;
  stepping: boolean;
  interruptedChange: string | null;
  stopRequested: boolean;
  fetchRequested: boolean;
  waitTimers: Map<string, NodeJS.Timeout>;
  sentinelTicker: NodeJS.Timeout | null;
  turnResolve: (() => void) | null;
  /** Loop wake callback (set by the entry; control/timer trigger it without
   *  importing the pipeline, avoiding a control↔pipeline import cycle). */
  wakeLoop: (() => void | Promise<void>) | null;
};

export const rt: RtState = {
  piRef: null,
  runCtx: null,
  loopActive: false,
  stepping: false,
  interruptedChange: null,
  stopRequested: false,
  fetchRequested: false,
  waitTimers: new Map(),
  sentinelTicker: null,
  turnResolve: null,
  wakeLoop: null,
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));
