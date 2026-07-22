import assert from "node:assert/strict";
import { BUILD_INNER, PHASE, REVIEW_INNER } from "./src/lifecycle-state.ts";
import { rt, type LoopState } from "./src/runtime.ts";
import { ResumeHarness } from "./resume-test-harness.ts";

type ResumeCase = {
  name: string;
  state: Partial<LoopState>;
  exercised: (h: ResumeHarness) => boolean;
}

const command = (h: ResumeHarness, ...prefix: string[]) =>
  h.commands.some((call) => prefix.every((part, index) => call[index] === part));

const cases: ResumeCase[] = [
  { name: "BUILD/IMPLEMENT", state: { phase: PHASE.BUILD, inner: BUILD_INNER.IMPLEMENT }, exercised: (h) => h.agentPrompts.some((p) => p.startsWith("Implement")) },
  { name: "BUILD/PUSH", state: { phase: PHASE.BUILD, inner: BUILD_INNER.PUSH }, exercised: (h) => command(h, "git", "push", "-u") },
  { name: "BUILD/PR", state: { phase: PHASE.BUILD, inner: BUILD_INNER.PR }, exercised: (h) => command(h, "gh", "pr", "list") },
  { name: "REVIEW/RECONCILE", state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.RECONCILE }, exercised: (h) => command(h, "git", "fetch", "origin", "main") },
  { name: "REVIEW/PROBE", state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.PROBE }, exercised: (h) => command(h, "gh", "pr", "view") },
  { name: "REVIEW/TRIGGER", state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.TRIGGER }, exercised: (h) => command(h, "gh", "pr", "comment") },
  {
    name: "REVIEW/FIX",
    state: {
      phase: PHASE.REVIEW, inner: REVIEW_INNER.FIX,
      suggestions: [{ severity: "P1", title: "fix", body: "body", path: "src/a.ts", line: 1 }],
    },
    exercised: (h) => h.agentPrompts.some((p) => p.startsWith("Codex review")),
  },
  { name: "REVIEW/RESOLVE_MAIN", state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.RESOLVE_MAIN }, exercised: (h) => h.agentPrompts.some((p) => p.startsWith("origin/main advanced")) },
  { name: "ARCHIVE", state: { phase: PHASE.ARCHIVE, inner: null }, exercised: (h) => command(h, "git", "fetch", "origin", "main") },
  { name: "MERGE", state: { phase: PHASE.MERGE, inner: null }, exercised: (h) => command(h, "gh", "pr", "merge") },
  { name: "CLEANUP", state: { phase: PHASE.CLEANUP, inner: null }, exercised: (h) => command(h, "git", "worktree", "remove") },
];

for (const testCase of cases) {
  const h = new ResumeHarness();
  try {
    h.persist(h.state(testCase.state));
    rt.interruptedChange = null; // model a fresh pi process: discovery must come from disk
    await h.resume();
    assert.ok(testCase.exercised(h), `${testCase.name} did not execute its persisted stage`);
    assert.equal(h.stateExists(), false, `${testCase.name} did not reach cleanup`);
    assert.equal(rt.loopActive, false, `${testCase.name} left the loop active`);
    assert.equal(rt.runCtx, null, `${testCase.name} retained run context`);
  } finally {
    h.dispose();
  }
}

console.log(`ALL ${cases.length} PERSISTED RESUME PHASES PASSED`);
