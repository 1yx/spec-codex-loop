import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLoopState } from "./src/control.ts";
import { BUILD_INNER, PHASE, REVIEW_INNER } from "./src/lifecycle-state.ts";
import { oneStep } from "./src/pipeline.ts";
import { FETCH_SENTINEL, STOP_SENTINEL, rt, type LoopState } from "./src/runtime.ts";
import { ResumeHarness, type HarnessOptions } from "./resume-test-harness.ts";

type RetryCase = {
  name: string;
  options: HarnessOptions;
  state: Partial<LoopState>;
  stopReason: string;
  prepare?: (h: ResumeHarness) => void;
}

async function retryTransient(testCase: RetryCase): Promise<void> {
  const h = new ResumeHarness(testCase.options);
  try {
    testCase.prepare?.(h);
    h.persist(h.state(testCase.state));
    await h.resume();
    const stopped = readLoopState(h.root, h.change);
    assert.ok(stopped, `${testCase.name} did not retain state after failure`);
    assert.equal(stopped.stopReason, testCase.stopReason, `${testCase.name} stored wrong stop reason`);
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false, `${testCase.name} did not complete after retry`);
  } finally {
    h.dispose();
  }
}

const transientCases: RetryCase[] = [
  {
    name: "build push failure",
    options: { failures: { "git push -u": 1 } },
    state: { phase: PHASE.BUILD, inner: BUILD_INNER.PUSH },
    stopReason: "push_failed",
  },
  {
    name: "PR creation failure",
    options: { failures: { "gh pr create": 1 }, prOpen: false },
    state: { phase: PHASE.BUILD, inner: BUILD_INNER.PR },
    stopReason: "pr_create_failed",
  },
  {
    name: "Codex trigger failure",
    options: { failures: { "gh pr comment": 1 } },
    state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.TRIGGER },
    stopReason: "trigger_failed",
  },
  {
    name: "archive command failure",
    options: { failures: { "openspec archive": 1 }, statusDirty: true },
    state: { phase: PHASE.ARCHIVE, inner: null },
    stopReason: "archive_failed",
    prepare: (h) => mkdirSync(join(h.root, ".worktree", h.change, "openspec", "changes", h.change), { recursive: true }),
  },
  {
    name: "merge command failure",
    options: { failures: { "gh pr merge": 1 } },
    state: { phase: PHASE.MERGE, inner: null },
    stopReason: "merge_failed",
  },
];

for (const testCase of transientCases) {await retryTransient(testCase);}

async function archiveFetchThenReview(): Promise<void> {
  const h = new ResumeHarness({ fetchFailures: 1, mergeChangesHead: 1 });
  try {
    h.persist(h.state({ phase: PHASE.ARCHIVE, inner: null }));
    await h.resume();
    assert.equal(readLoopState(h.root, h.change)?.stopReason, "archive_fetch_failed");
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
    assert.ok(h.notifications.some((n) => n.message.includes("returning to Codex review")));
  } finally {
    h.dispose();
  }
}

async function archivePushFailureRetainsReviewGate(): Promise<void> {
  const h = new ResumeHarness({ mergeChangesHead: 1, failures: { "git push": 1 } });
  try {
    const approvedHead = h.head;
    h.persist(h.state({ phase: PHASE.ARCHIVE, inner: null }));
    await h.resume();
    const stopped = readLoopState(h.root, h.change);
    assert.equal(stopped?.stopReason, "archive_push_failed");
    assert.equal(stopped?.head, approvedHead, "failed push must not mark the merged head approved");
    assert.notEqual(h.head, approvedHead, "test setup did not create a new merged head");
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
    assert.ok(h.notifications.some((n) => n.message.includes("returning to Codex review")));
  } finally {
    h.dispose();
  }
}

async function agent429Retries(): Promise<void> {
  const cases: Array<{ name: string; options: HarnessOptions; state: Partial<LoopState> }> = [
    {
      name: "IMPLEMENT",
      options: { agentSteps: [{ error: "429 Too Many Requests", commitOnError: true }, { noCommit: true }] },
      state: { phase: PHASE.BUILD, inner: BUILD_INNER.IMPLEMENT },
    },
    {
      name: "FIX with commit before 429",
      options: { agentSteps: [{ error: "rate limit exceeded", commitOnError: true }, { noCommit: true }] },
      state: {
        phase: PHASE.REVIEW, inner: REVIEW_INNER.FIX,
        suggestions: [{ severity: "P1", title: "fix", body: "body", path: "src/a.ts", line: 1 }],
      },
    },
    {
      name: "RESOLVE_MAIN with unfinished merge",
      options: { agentSteps: [{ error: "HTTP 429" }, {}], unmerged: true },
      state: { phase: PHASE.REVIEW, inner: REVIEW_INNER.RESOLVE_MAIN },
    },
  ];

  for (const testCase of cases) {
    const h = new ResumeHarness(testCase.options);
    try {
      h.persist(h.state(testCase.state));
      const originalHead = h.head;
      await h.resume();
      const stopped = readLoopState(h.root, h.change);
      assert.equal(stopped?.stopReason, "agent_rate_limited", `${testCase.name} did not classify 429`);
      assert.equal(stopped?.phase, testCase.state.phase);
      assert.equal(stopped?.inner, testCase.state.inner);
      if (testCase.name.startsWith("FIX")) {
        assert.equal(stopped?.agentHead, originalHead);
        assert.equal(stopped?.suggestions.length, 1);
      }
      rt.interruptedChange = null;
      await h.resume();
      assert.equal(h.stateExists(), false, `${testCase.name} did not complete on second resume`);
    } finally {
      h.dispose();
    }
  }
}

async function fixCommitThenPushFailure(): Promise<void> {
  const h = new ResumeHarness({ failures: { "git push": 1 }, agentSteps: [{}, { noCommit: true }] });
  try {
    h.persist(h.state({
      phase: PHASE.REVIEW, inner: REVIEW_INNER.FIX,
      suggestions: [{ severity: "P1", title: "fix", body: "body", path: "src/a.ts", line: 1 }],
    }));
    const baseHead = h.head;
    await h.resume();
    const stopped = readLoopState(h.root, h.change);
    assert.equal(stopped?.stopReason, "push_failed");
    assert.equal(stopped?.agentHead, baseHead);
    assert.notEqual(h.head, baseHead);
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
  } finally {
    h.dispose();
  }
}

async function resolvedMergeThenSyncPushFailure(): Promise<void> {
  const h = new ResumeHarness({ failures: { "git push": 1 }, unmerged: true });
  try {
    h.persist(h.state({ phase: PHASE.REVIEW, inner: REVIEW_INNER.RESOLVE_MAIN }));
    await h.resume();
    const stopped = readLoopState(h.root, h.change);
    assert.equal(stopped?.stopReason, "sync_push_failed");
    assert.equal(stopped?.inner, REVIEW_INNER.RECONCILE);
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
  } finally {
    h.dispose();
  }
}

async function archiveCommitThenPushFailure(): Promise<void> {
  const h = new ResumeHarness({ failures: { "git push": 1 }, statusDirty: true });
  try {
    mkdirSync(join(h.root, ".worktree", h.change, "openspec", "changes", h.change), { recursive: true });
    const approvedHead = h.head;
    h.persist(h.state({ phase: PHASE.ARCHIVE, inner: null }));
    await h.resume();
    assert.equal(readLoopState(h.root, h.change)?.stopReason, "archive_push_failed");
    assert.notEqual(h.head, approvedHead);
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
    assert.ok(h.notifications.some((n) => n.message.includes("returning to Codex review")));
  } finally {
    h.dispose();
  }
}

async function automaticRetrySettlesBeforeAdvance(): Promise<void> {
  const h = new ResumeHarness({ agentSteps: [{ intermediateError: "429 Too Many Requests" }] });
  try {
    h.persist(h.state({ phase: PHASE.BUILD, inner: BUILD_INNER.IMPLEMENT }));
    await h.resume();
    assert.equal(h.stateExists(), false);
    assert.equal(h.notifications.some((n) => n.message.includes("rate limiting")), false);
  } finally {
    h.dispose();
  }
}

async function successfulFixTriggersReviewForNewHead(): Promise<void> {
  const h = new ResumeHarness({ reviewMode: "pending" });
  try {
    h.persist(h.state({
      phase: PHASE.REVIEW, inner: REVIEW_INNER.FIX,
      triggerAt: "2026-07-22T00:00:00Z", reviewDeadline: Temporal.Now.instant().epochMilliseconds + 60_000,
      suggestions: [{ severity: "P1", title: "fix", body: "body", path: "src/a.ts", line: 1 }],
    }));
    await h.resume();
    assert.equal(rt.loopActive, true);
    assert.ok(h.commands.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment"));
    h.reviewMode = "pass";
    await h.run("fetch");
    for (let i = 0; i < 20 && h.stateExists(); i++) {await new Promise((resolve) => setTimeout(resolve, 5));}
    assert.equal(h.stateExists(), false);
  } finally {
    h.dispose();
  }
}

async function stoppedProbeReconcilesManualHead(): Promise<void> {
  const h = new ResumeHarness();
  try {
    const stopped = h.state({
      phase: PHASE.REVIEW, inner: REVIEW_INNER.PROBE, stopReason: "repeat",
      triggerAt: "2026-07-22T00:00:00Z", reviewDeadline: 1,
      seenSignatures: ["src/a.ts:1|old issue"],
    });
    h.persist(stopped);
    h.head = "bbbbbbb222222222222222222222222222222222";
    h.remoteHead = h.head;
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
    assert.equal(h.notifications.some((n) => n.message.includes("head_not_pushed")), false);
  } finally {
    h.dispose();
  }
}

async function legacyFixStateReprobes(): Promise<void> {
  const h = new ResumeHarness({ reviewMode: "suggestions", passAfterAgent: true });
  try {
    h.persist(h.state({
      phase: PHASE.REVIEW, inner: REVIEW_INNER.FIX, suggestions: [],
      seenSignatures: ["src/a.ts:1|Fix issue"],
    }));
    await h.resume();
    assert.equal(h.stateExists(), false);
    assert.ok(h.agentPrompts.some((prompt) => prompt.startsWith("Codex review")));
  } finally {
    h.dispose();
  }
}

async function codexBotStopRetriggers(mode: "error" | "quota", reason: string): Promise<void> {
  const h = new ResumeHarness({ reviewMode: mode });
  try {
    const state = h.state({
      phase: PHASE.REVIEW, inner: REVIEW_INNER.PROBE,
      triggerAt: "2026-07-22T00:00:00Z", reviewDeadline: Temporal.Now.instant().epochMilliseconds + 60_000,
      stopReason: null,
    });
    const outcome = await oneStep({
      pi: h.pi, ctx: h.ctx, change: h.change, s: state,
      wtDir: join(h.root, ".worktree", h.change), persist: () => h.persist(state),
    });
    assert.equal(outcome, "stop");
    assert.equal(state.stopReason, reason);
    assert.equal(state.triggerAt, null);
    assert.equal(state.reviewDeadline, null);

    h.reviewMode = "pending";
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(rt.loopActive, true);
    assert.ok(h.commands.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "comment"));

    h.reviewMode = "pass";
    await h.run("fetch");
    for (let i = 0; i < 20 && h.stateExists(); i++) {await new Promise((resolve) => setTimeout(resolve, 5));}
    assert.equal(h.stateExists(), false, `${mode} recovery did not complete after re-trigger`);
  } finally {
    h.dispose();
  }
}

async function multipleStoppedChangesAreNotGuessed(): Promise<void> {
  const h = new ResumeHarness();
  try {
    h.persist(h.state(), "change-a");
    h.persist(h.state(), "change-b");
    await h.resume();
    assert.equal(h.stateExists("change-a"), true);
    assert.equal(h.stateExists("change-b"), true);
    assert.equal(h.commands.length, 0);
    assert.ok(h.notifications.some((n) => n.message.includes("multiple resumable changes")));
  } finally {
    h.dispose();
  }
}

async function stopThenResumeFromDisk(): Promise<void> {
  const h = new ResumeHarness({ reviewMode: "pending" });
  try {
    h.persist(h.state({
      phase: PHASE.REVIEW, inner: REVIEW_INNER.PROBE,
      triggerAt: "2026-07-22T00:00:00Z", reviewDeadline: Date.now() + 60_000,
    }));
    await h.resume();
    assert.equal(rt.loopActive, true);
    assert.equal(rt.waitTimers.has(h.change), true);
    await h.run("stop");
    for (let i = 0; i < 20 && rt.loopActive; i++) {await new Promise((resolve) => setTimeout(resolve, 5));}
    assert.equal(rt.loopActive, false);
    assert.equal(readLoopState(h.root, h.change)?.stopReason, "stopped");
    h.reviewMode = "pass";
    rt.interruptedChange = null;
    await h.resume();
    assert.equal(h.stateExists(), false);
  } finally {
    h.dispose();
  }
}

async function staleControlsAreCleared(): Promise<void> {
  const h = new ResumeHarness();
  try {
    h.persist(h.state({ phase: PHASE.CLEANUP, inner: null }));
    const fetchPath = join(h.root, FETCH_SENTINEL);
    const stopPath = join(h.root, STOP_SENTINEL);
    writeFileSync(fetchPath, ""); writeFileSync(stopPath, "");
    rt.fetchRequested = true; rt.stopRequested = true;
    rt.waitTimers.set(h.change, setTimeout(() => {}, 60_000));
    await h.resume();
    assert.equal(existsSync(fetchPath), false);
    assert.equal(existsSync(stopPath), false);
    assert.equal(rt.fetchRequested, false);
    assert.equal(rt.stopRequested, false);
    assert.equal(rt.waitTimers.has(h.change), false);
    assert.equal(rt.sentinelTicker, null);
  } finally {
    h.dispose();
  }
}

await archiveFetchThenReview();
await archivePushFailureRetainsReviewGate();
await agent429Retries();
await fixCommitThenPushFailure();
await resolvedMergeThenSyncPushFailure();
await archiveCommitThenPushFailure();
await automaticRetrySettlesBeforeAdvance();
await successfulFixTriggersReviewForNewHead();
await stoppedProbeReconcilesManualHead();
await legacyFixStateReprobes();
await codexBotStopRetriggers("quota", "quota");
await codexBotStopRetriggers("error", "codex_error");
await multipleStoppedChangesAreNotGuessed();
await stopThenResumeFromDisk();
await staleControlsAreCleared();
console.log("ALL 22 RESUME FAILURE/RECOVERY SCENARIOS PASSED");
