/**
 * lifecycle-state — pure outer lifecycle state model for dev-loop.
 *
 * No I/O, no side effects. The review phase carries its own inner machine
 * (REVIEW_INNER), driven imperatively by the re-entrant stepReview; this module
 * owns only the outer phase graph + the reality→phase resolver used for resume
 * and fallback. Modeled on dev-loops' packages/core/src/loop/lifecycle-state.mjs
 * (purely functional; deterministic; consultable).
 *
 * Contract:
 * - One deterministic outer phase per normalized reality-probe set.
 * - Unknown explicit `phase` falls through to inference (never throws).
 * - Resume reads persisted `phase`; if absent/corrupt, resolvePhase(reality)
 *   re-derives it so a loop started before this module (or after a crash) still
 *   re-enters correctly.
 */

export const PHASE = Object.freeze({
  RESOLVE: "resolve",       // detect prior-run state, decide entry
  PROVISION: "provision",   // worktree + env + openspec
  BUILD: "build",           // openspec-apply-change → commit → push → gh pr create
  REVIEW: "review",         // Codex review/fix loop (inner machine below)
  ARCHIVE: "archive",       // openspec archive → commit → push
  MERGE: "merge",           // gh pr merge --squash --delete-branch
  CLEANUP: "cleanup",       // remove worktree + mark TODO [x]
} as const);

/**
 *
 */
export type Phase = (typeof PHASE)[keyof typeof PHASE];

const PHASE_VALUES: readonly Phase[] = Object.values(PHASE);
const PHASE_SET: ReadonlySet<string> = new Set(PHASE_VALUES);

/** Inner states of the review phase — the only phase with sub-states. These are
 *  what make review re-entrant: each persisted inner state is a clean re-entry
 *  point, so the loop never holds the command handler open across a poll. */
export const REVIEW_INNER = Object.freeze({
  RECONCILE: "review_reconcile", // fetch + reconcile local/origin HEAD
  PROBE: "review_probe",         // readCodexVerdict once (no side effects)
  TRIGGER: "review_trigger",     // post @codex review, record triggerAt + deadline
  FIX: "review_fix",             // fixPhase (agent turn), next round
  RESOLVE_MAIN: "review_resolve_main", // agent resolves origin/main merge conflicts (context-aware), then re-review
} as const);

/**
 *
 */
export type ReviewInner = (typeof REVIEW_INNER)[keyof typeof REVIEW_INNER];

/** Inner states of the build phase: implement+commit → push → open PR. Each is a
 *  persisted, re-entrant step, so a crash between them resumes at the right one
 *  instead of re-running the whole (creative, expensive) implement turn. */
export const BUILD_INNER = Object.freeze({
  IMPLEMENT: "build_implement", // agent: openspec-apply-change + tests + commit
  PUSH: "build_push",           // git push -u origin <change>
  PR: "build_pr",               // gh pr create → enter REVIEW
} as const);

/**
 *
 */
export type BuildInner = (typeof BUILD_INNER)[keyof typeof BUILD_INNER];

/** Legal outer transitions. Flow is linear; the review loop lives inside REVIEW
 *  via REVIEW_INNER, so REVIEW → ARCHIVE is the only forward edge out of it.
 *  RESOLVE → CLEANUP is the "already merged in a prior run" shortcut. */
export const OUTER_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = Object.freeze({
  [PHASE.RESOLVE]: [PHASE.PROVISION, PHASE.CLEANUP],
  [PHASE.PROVISION]: [PHASE.BUILD],
  [PHASE.BUILD]: [PHASE.REVIEW],
  [PHASE.REVIEW]: [PHASE.ARCHIVE],
  [PHASE.ARCHIVE]: [PHASE.MERGE],
  [PHASE.MERGE]: [PHASE.CLEANUP],
  [PHASE.CLEANUP]: [],
});

export const TERMINAL_PHASES: readonly Phase[] = Object.freeze([PHASE.CLEANUP]);

/**
 *
 */
export type RealityProbes = {
  /** Explicit phase override (e.g. read from .loop-state.json). Unknown → ignore. */
  phase?: string | null;
  /** Does the worktree .worktree/<change> exist? */
  wtExists: boolean;
  /** PR state for the change branch. */
  prState: "none" | "open" | "merged";
  /** Has the openspec change been archived (moved out of openspec/changes/)? */
  archived: boolean;
}

/**
 *
 */
export type ResolveResult = {
  phase: Phase;
  allowedTransitions: readonly Phase[];
  isTerminal: boolean;
}

/**
 * Resolve the outer phase to (re)enter from authoritative reality probes.
 * First-match order mirrors runTask's prior implicit resume logic, formalized:
 *
 * 1. explicit phase override (if recognized; unknown falls through)
 * 2. merged PR → cleanup (finish teardown + TODO mark)
 * 3. no worktree → provision
 * 4. open PR + archived → merge (review passed, archive done)
 * 5. open PR + not archived → review
 * 6. no PR + worktree exists → build
 * 7. fallback → provision
 */
export function resolvePhase(input: RealityProbes): ResolveResult {
  const { phase = null, wtExists, prState, archived } = input;

  if (phase) {
    if (isPhase(phase)) {return buildResult(phase);}
    // unrecognized explicit phase: fall through to inference
  }
  if (prState === "merged") {return buildResult(PHASE.CLEANUP);}
  if (!wtExists) {return buildResult(PHASE.PROVISION);}
  if (prState === "open") {return buildResult(archived ? PHASE.MERGE : PHASE.REVIEW);}
  if (prState === "none") {return buildResult(PHASE.BUILD);}
  return buildResult(PHASE.PROVISION);
}

/**
 *
 */
function buildResult(phase: Phase): ResolveResult {
  return {
    phase,
    allowedTransitions: OUTER_TRANSITIONS[phase],
    isTerminal: TERMINAL_PHASES.includes(phase),
  };
}

/**
 *
 */
export function isKnownPhase(value: string): boolean {
  return PHASE_SET.has(value);
}

/** Type guard: narrows a string to Phase when it's a known phase value. */
export function isPhase(value: string): value is Phase {
  return PHASE_SET.has(value);
}

/**
 *
 */
export function isTransitionAllowed(from: Phase, to: Phase): boolean {
  return OUTER_TRANSITIONS[from]?.includes(to) ?? false;
}
