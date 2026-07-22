import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readLoopState } from "./src/control.ts";
import { oneStep } from "./src/pipeline.ts";
import { evaluateReviewCircuit } from "./src/review-circuit-breaker.ts";
import { REVIEW_INNER } from "./src/lifecycle-state.ts";
import { rt, type ReviewHistoryEntry } from "./src/runtime.ts";
import { ResumeHarness } from "./resume-test-harness.ts";

type EntryOptions = { title: string; severity?: string; epoch?: number; count?: number };

const entry = (round: number, path: string, options: EntryOptions): ReviewHistoryEntry => ({
  epoch: options.epoch ?? 0,
  round,
  head: `${round}`.repeat(40),
  findings: Array.from({ length: options.count ?? 1 }, (_, index) => ({
    severity: options.severity ?? "P2",
    title: `${options.title} ${index}`,
    path,
    line: round + index,
  })),
  fixHead: null,
});

{
  const decision = evaluateReviewCircuit([
    entry(1, "src/control.ts", { title: "lock order" }),
    entry(2, "src/control.ts", { title: "stale owner" }),
    entry(3, "src/control.ts", { title: "reclaim race" }),
  ], 0);
  assert.equal(decision.stopReason, "strategy_required");
  assert.match(decision.summary ?? "", /same area/);
}

{
  const decision = evaluateReviewCircuit([
    entry(1, "src/auth/login.ts", { title: "login" }),
    entry(2, "src/auth/oauth/google.ts", { title: "oauth" }),
    entry(3, "src/auth/session.ts", { title: "session" }),
  ], 0);
  assert.equal(decision.stopReason, "strategy_required");
  assert.match(decision.summary ?? "", /same area: src\/auth\//);
}

{
  const decision = evaluateReviewCircuit([
    entry(1, "src/control.ts", { title: "lock" }),
    entry(2, "test/pipeline.ts", { title: "review" }),
    entry(3, "docs/dev-loop.md", { title: "resume" }),
  ], 0);
  assert.equal(decision.stopReason, null, "unrelated findings should continue before the hard limit");
}

{
  const decision = evaluateReviewCircuit([
    entry(1, "src/pipeline.ts", { title: "first", severity: "P2" }),
    entry(2, "src/pipeline.ts", { title: "second", severity: "P2" }),
    entry(3, "src/pipeline.ts", { title: "worse", severity: "P1" }),
  ], 0);
  assert.equal(decision.stopReason, "strategy_required");
  assert.match(decision.summary ?? "", /severity escalated \(P2 -> P1\)/);
}

{
  const decision = evaluateReviewCircuit([
    entry(1, "a.ts", { title: "a" }), entry(2, "b.ts", { title: "b" }), entry(3, "c.ts", { title: "c" }),
    entry(4, "d.ts", { title: "d" }), entry(5, "e.ts", { title: "e" }),
  ], 0);
  assert.equal(decision.stopReason, "review_round_limit");
}

{
  const old = [1, 2, 3, 4, 5].map((round) => entry(round, `${round}.ts`, { title: "old" }));
  const decision = evaluateReviewCircuit([...old, entry(6, "new-a.ts", { title: "new", epoch: 1 })], 1);
  assert.equal(decision.stopReason, null, "a resumed strategy epoch must get a fresh failure budget");
}

async function pipelineStopsBeforeFix(): Promise<void> {
  const h = new ResumeHarness({ reviewMode: "suggestions" });
  try {
    const state = h.state({
      inner: REVIEW_INNER.PROBE,
      stopReason: null,
      reviewHistory: [
        entry(1, "src/a.ts", { title: "first" }),
        entry(2, "src/a.ts", { title: "second" }),
      ],
      round: 3,
    });
    const outcome = await oneStep({
      pi: h.pi,
      ctx: h.ctx,
      change: h.change,
      s: state,
      wtDir: join(h.root, ".worktree", h.change),
      persist: () => h.persist(state),
    });
    assert.equal(outcome, "stop");
    assert.equal(state.stopReason, "strategy_required");
    assert.equal(state.reviewHistory.length, 3);
    assert.equal(h.agentPrompts.length, 0, "the circuit must stop before starting a FIX turn");
  } finally {h.dispose();}
}

async function strategyStopRequiresForce(): Promise<void> {
  const h = new ResumeHarness({ reviewMode: "pending" });
  try {
    h.persist(h.state({
      inner: REVIEW_INNER.PROBE,
      stopReason: "strategy_required",
      stopSummary: "review churn score 6",
      reviewHistory: [
        entry(1, "src/a.ts", { title: "first" }),
        entry(2, "src/a.ts", { title: "second" }),
        entry(3, "src/a.ts", { title: "third" }),
      ],
    }));
    mkdirSync(join(h.root, "openspec", "changes", h.change), { recursive: true });
    await h.run(h.change);
    assert.equal(readLoopState(h.root, h.change)?.stopReason, "strategy_required", "a normal named run must not bypass the circuit");
    assert.equal(h.agentPrompts.length, 0);

    await h.run(`resume ${h.change}`);
    const resumed = readLoopState(h.root, h.change);
    assert.equal(rt.loopActive, true);
    assert.equal(resumed?.strategyEpoch, 1, "explicit resume starts a fresh detection window");
    assert.equal(resumed?.stopReason, null);

    h.reviewMode = "pass";
    await h.run("fetch");
    for (let i = 0; i < 20 && h.stateExists(); i++) {await new Promise((resolve) => setTimeout(resolve, 5));}
    assert.equal(h.stateExists(), false);
  } finally {h.dispose();}
}

await pipelineStopsBeforeFix();
await strategyStopRequiresForce();
console.log("ALL 8 REVIEW CIRCUIT BREAKER CHECKS PASSED");
