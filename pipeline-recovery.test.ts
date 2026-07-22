import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUILD_INNER, PHASE, REVIEW_INNER } from "./src/lifecycle-state.ts";
import registerDevLoop from "./src/dev-loop.ts";
import { oneStep } from "./src/pipeline.ts";
import type { LoopState } from "./src/runtime.ts";

const baseState = (phase: string, inner: string | null): LoopState => ({
  phase, inner, round: 1, prNum: 42, head: "aaaaaaa1111111", repo: "owner/repo",
  triggerAt: "2026-07-22T00:00:00Z", reviewDeadline: 123,
  seenSignatures: [], suggestions: [], stopReason: null, oneOff: true,
});

const context = () => {
  const notifications: Array<{ message: string; level: string | undefined }> = [];
  return {
    ctx: { cwd: "/repo", ui: { notify: (message: string, level?: "info" | "warning" | "error") => notifications.push({ message, level }) } },
    notifications,
  };
};

async function archiveFetchFailure(): Promise<void> {
  const s = baseState(PHASE.ARCHIVE, null);
  const { ctx } = context();
  let persisted = 0;
  // Test doubles only implement the ExtensionAPI surface exercised by this step.
  const pi = { exec: (command: string, args: string[]) => {
    assert.deepEqual([command, ...args], ["git", "fetch", "origin", "main"]);
    return Promise.resolve({ code: 1, stdout: "", stderr: "network down" });
  } } as unknown as ExtensionAPI;
  const outcome = await oneStep({ pi, ctx, change: "change", s, wtDir: "/worktree", persist: () => persisted++ });
  assert.equal(outcome, "stop");
  assert.equal(s.stopReason, "archive_fetch_failed");
  assert.equal(s.phase, PHASE.ARCHIVE);
  assert.equal(persisted, 1);
}

async function changedMainRequiresReview(): Promise<void> {
  const s = baseState(PHASE.ARCHIVE, null);
  const { ctx } = context();
  const calls: string[][] = [];
  const replies = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "bbbbbbb2222222", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  ];
  const pi = { exec: (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return Promise.resolve(replies.shift() ?? { code: 1, stdout: "", stderr: "unexpected command" });
  } } as unknown as ExtensionAPI;
  const outcome = await oneStep({ pi, ctx, change: "change", s, wtDir: "/worktree", persist: () => {} });
  assert.equal(outcome, "cont");
  assert.equal(s.phase, PHASE.REVIEW);
  assert.equal(s.inner, REVIEW_INNER.PROBE);
  assert.equal(s.head, "bbbbbbb2222222");
  assert.equal(s.triggerAt, null);
  assert.equal(s.reviewDeadline, null);
  assert.deepEqual(calls.at(-1), ["git", "push"]);
}

async function rateLimitKeepsAgentStages(): Promise<void> {
  const handlers = new Map<string, (event?: unknown) => unknown>();
  const fake = {
    on: (event: string, handler: (event?: unknown) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    exec: () => Promise.resolve({ code: 0, stdout: "aaaaaaa1111111", stderr: "" }),
    sendUserMessage: () => setImmediate(() => {
      handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" }] });
      handlers.get("agent_settled")?.();
    }),
  } as unknown as ExtensionAPI;
  registerDevLoop(fake);

  for (const [phase, inner] of [
    [PHASE.BUILD, BUILD_INNER.IMPLEMENT],
    [PHASE.REVIEW, REVIEW_INNER.FIX],
    [PHASE.REVIEW, REVIEW_INNER.RESOLVE_MAIN],
  ]) {
    const s = baseState(phase, inner);
    s.suggestions = [{ severity: "P1", title: "fix", body: "body", path: "src/a.ts", line: 1 }];
    const { ctx } = context();
    const outcome = await oneStep({ pi: fake, ctx, change: "change", s, wtDir: "/worktree", persist: () => {} });
    assert.equal(outcome, "stop");
    assert.equal(s.phase, phase);
    assert.equal(s.inner, inner);
    assert.equal(s.stopReason, "agent_rate_limited");
  }
}

await archiveFetchFailure();
await changedMainRequiresReview();
await rateLimitKeepsAgentStages();
console.log("ALL 5 PIPELINE RECOVERY CHECKS PASSED");
