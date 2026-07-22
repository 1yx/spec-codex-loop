import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_INNER, PHASE, REVIEW_INNER } from "./src/lifecycle-state.ts";
import type { LoopState } from "./src/runtime.ts";
import { ResumeHarness, type HarnessOptions } from "./resume-test-harness.ts";

type CrashCase = {
  name: string;
  options: (when: "after" | "before") => HarnessOptions;
  state: Partial<LoopState>;
  prepare?: (h: ResumeHarness) => void;
  verify?: (h: ResumeHarness) => void;
}

const archiveChange = (h: ResumeHarness) =>
  mkdirSync(join(h.root, ".worktree", h.change, "openspec", "changes", h.change), { recursive: true });

const cases: CrashCase[] = [
  {
    name: "agent implementation",
    options: (when) => ({ agentSteps: [{ crash: when }, {}] }),
    state: { phase: PHASE.BUILD, inner: BUILD_INNER.IMPLEMENT },
  },
  {
    name: "branch push",
    options: (when) => ({ crashes: { "git push -u": { when } } }),
    state: { phase: PHASE.BUILD, inner: BUILD_INNER.PUSH },
  },
  {
    name: "PR creation",
    options: (when) => ({ crashes: { "gh pr create": { when } }, prOpen: false }),
    state: { phase: PHASE.BUILD, inner: BUILD_INNER.PR },
  },
  {
    name: "Codex trigger",
    options: (when) => ({ crashes: { "gh pr comment": { when } } }),
    state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.TRIGGER },
    verify: (h) => assert.equal(h.postedComments.length, 1, "trigger must be posted exactly once"),
  },
  {
    name: "openspec archive",
    options: (when) => ({ crashes: { "openspec archive": { when } }, statusDirty: true }),
    state: { phase: PHASE.ARCHIVE, inner: null },
    prepare: archiveChange,
  },
  {
    name: "archive commit",
    options: (when) => ({ crashes: { "git commit": { when } }, statusDirty: true }),
    state: { phase: PHASE.ARCHIVE, inner: null },
    prepare: archiveChange,
  },
  {
    name: "archive push",
    options: (when) => ({ crashes: { "git push": { when } }, statusDirty: true }),
    state: { phase: PHASE.ARCHIVE, inner: null },
    prepare: archiveChange,
  },
  {
    name: "PR merge",
    options: (when) => ({ crashes: { "gh pr merge": { when } } }),
    state: { phase: PHASE.MERGE, inner: null },
  },
  {
    name: "worktree removal",
    options: (when) => ({ crashes: { "git worktree remove": { when } } }),
    state: { phase: PHASE.CLEANUP, inner: null },
  },
];

for (const testCase of cases) {
  for (const when of ["before", "after"] as const) {
    const h = new ResumeHarness(testCase.options(when));
    try {
      testCase.prepare?.(h);
      h.persist(h.state(testCase.state));
      try {await h.resume();} catch { /* simulated process death */ }
      const finalRemoval = testCase.name === "worktree removal" && when === "after";
      assert.equal(h.stateExists(), !finalRemoval, `${testCase.name}/${when} recovery-state mismatch`);
      h.restart();
      await h.resume();
      assert.equal(h.stateExists(), false, `${testCase.name}/${when} did not recover to cleanup`);
      testCase.verify?.(h);
    } finally {h.dispose();}
  }
}

console.log(`ALL ${cases.length * 2} CRASH BOUNDARIES RECOVERED`);
