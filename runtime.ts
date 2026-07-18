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
export interface Suggestion {
  severity: string | null;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}

export interface PollResult {
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

export interface LoopState {
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

export type ReconcileResult =
  | { kind: "ok"; head: string }
  | { kind: "diverged" }
  | { kind: "sync_push_failed"; stderr: string }
  | { kind: "main_merged_clean"; head: string }
  | { kind: "main_conflict" };

export type RunCtx = {
  ctx: any;
  change: string;
  dryRun: boolean;
  all: boolean;
  oneOff: boolean;
};

// --- shared mutable runtime state (singleton; imported + mutated across modules) ---
export const rt = {
  piRef: null as ExtensionAPI | null,
  runCtx: null as RunCtx | null,
  loopActive: false,
  stepping: false,
  interruptedChange: null as string | null,
  stopRequested: false,
  fetchRequested: false,
  waitTimers: new Map<string, NodeJS.Timeout>(),
  sentinelTicker: null as NodeJS.Timeout | null,
  turnResolve: null as (() => void) | null,
  /** Loop wake callback (set by the entry; control/timer trigger it without
   *  importing the pipeline, avoiding a control↔pipeline import cycle). */
  wakeLoop: null as (() => void) | null,
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));
