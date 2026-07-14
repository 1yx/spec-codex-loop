// Unit tests for lifecycle-state.ts. Run directly: node lifecycle-state.test.ts
// Cases derived from runTask's actual resume branches (the logic this formalizes).
import assert from "node:assert/strict";
import { PHASE, resolvePhase, isKnownPhase, isTransitionAllowed, OUTER_TRANSITIONS } from "./lifecycle-state.ts";

let passed = 0;
const check = (name: string, cond: boolean) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

console.log("resolvePhase — reality inference (no explicit phase):");
// 1. Fresh start: no worktree, no PR.
check("fresh → provision",
  resolvePhase({ wtExists: false, prState: "none", archived: false }).phase === PHASE.PROVISION);
// 2. Already merged in a prior run (merged wins over everything, even no worktree).
check("merged + no worktree → cleanup",
  resolvePhase({ wtExists: false, prState: "merged", archived: false }).phase === PHASE.CLEANUP);
check("merged + worktree + open-ish → cleanup (merged dominates)",
  resolvePhase({ wtExists: true, prState: "merged", archived: false }).phase === PHASE.CLEANUP);
// 3. Worktree exists, no PR yet → build (create the PR).
check("worktree + no PR → build",
  resolvePhase({ wtExists: true, prState: "none", archived: false }).phase === PHASE.BUILD);
// 4. Open PR, not archived → review.
check("open PR, not archived → review",
  resolvePhase({ wtExists: true, prState: "open", archived: false }).phase === PHASE.REVIEW);
// 5. Open PR + archived → merge (review passed, archive done).
check("open PR + archived → merge",
  resolvePhase({ wtExists: true, prState: "open", archived: true }).phase === PHASE.MERGE);

console.log("resolvePhase — explicit phase override:");
check("explicit review → review",
  resolvePhase({ phase: "review", wtExists: false, prState: "none", archived: false }).phase === PHASE.REVIEW);
check("explicit archive overrides merged reality",
  resolvePhase({ phase: "archive", wtExists: true, prState: "merged", archived: true }).phase === PHASE.ARCHIVE);
check("unknown explicit phase falls through to inference",
  resolvePhase({ phase: "bogus", wtExists: false, prState: "none", archived: false }).phase === PHASE.PROVISION);

console.log("resolvePhase — result shape:");
const r = resolvePhase({ wtExists: true, prState: "open", archived: false });
check("review allowedTransitions === [archive]",
  r.allowedTransitions.length === 1 && r.allowedTransitions[0] === PHASE.ARCHIVE);
check("review not terminal", r.isTerminal === false);
check("cleanup terminal",
  resolvePhase({ wtExists: false, prState: "merged", archived: false }).isTerminal === true);

console.log("transition graph:");
check("resolve→provision allowed",
  isTransitionAllowed(PHASE.RESOLVE, PHASE.PROVISION) === true);
check("resolve→cleanup allowed (merged shortcut)",
  isTransitionAllowed(PHASE.RESOLVE, PHASE.CLEANUP) === true);
check("review→merge NOT allowed (must pass archive)",
  isTransitionAllowed(PHASE.REVIEW, PHASE.MERGE) === false);
check("cleanup has no outgoing edges",
  OUTER_TRANSITIONS[PHASE.CLEANUP].length === 0);

console.log("helpers:");
check("isKnownPhase('review')", isKnownPhase("review") === true);
check("isKnownPhase('nope')", isKnownPhase("nope") === false);

console.log(`\nALL ${passed} CHECKS PASSED`);
