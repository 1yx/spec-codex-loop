import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyControl,
  clearWaitTimer,
  pollSentinels,
  readLoopState,
  scheduleWait,
  waitAction,
} from "./src/control.ts";
import { FETCH_SENTINEL, STOP_SENTINEL, rt, type LoopCtx } from "./src/runtime.ts";
import { ResumeHarness } from "./resume-test-harness.ts";

let passed = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  passed++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resetControlRuntime(): void {
  for (const timer of rt.waitTimers.values()) {clearTimeout(timer);}
  rt.waitTimers.clear();
  rt.runCtx = null;
  rt.stopRequested = false;
  rt.fetchRequested = false;
  rt.stepping = false;
  rt.wakeLoop = null;
}

console.log("deadline and control precedence:");
const NOW = 10_000;
check("deadline is inclusive", waitAction(false, NOW, NOW) === "timeout");
check("one millisecond before deadline still waits", waitAction(false, NOW, NOW - 1) === "wait");
check("fetch wins at the exact deadline", waitAction(true, NOW, NOW) === "recheck");

{
  const h = new ResumeHarness();
  try {
    const ctx = h.ctx;
    rt.runCtx = { ctx, change: h.change, dryRun: false, all: false, oneOff: true };
    writeFileSync(join(h.root, FETCH_SENTINEL), "");
    writeFileSync(join(h.root, STOP_SENTINEL), "");
    pollSentinels(ctx);
    check("stop wins when both sentinel files exist", rt.stopRequested && !rt.fetchRequested);
    check("winning stop consumes both sentinel files", !existsSync(join(h.root, STOP_SENTINEL)) && !existsSync(join(h.root, FETCH_SENTINEL)));
  } finally {h.dispose();}
}

console.log("timer generation isolation:");
{
  const root = "/tmp/spec-loop-timer-test";
  const ctx: LoopCtx = { cwd: root, ui: { notify: () => undefined } };
  let wakes = 0;
  resetControlRuntime();
  rt.runCtx = { ctx, change: "old", dryRun: false, all: false, oneOff: true };
  rt.wakeLoop = () => {wakes++;};
  scheduleWait(10);
  rt.runCtx = { ...rt.runCtx, change: "new" };
  await sleep(25);
  check("timer from an old change cannot wake a new run", wakes === 0);
  clearWaitTimer("old");

  rt.runCtx = { ...rt.runCtx, change: "same" };
  scheduleWait(10);
  const replacement = setTimeout(() => undefined, 1000);
  replacement.unref?.();
  rt.waitTimers.set("same", replacement);
  await sleep(25);
  check("superseded timer callback cannot wake the loop", wakes === 0);
  clearWaitTimer("same");

  scheduleWait(10);
  await sleep(25);
  check("current timer wakes exactly once and removes itself", wakes === 1 && !rt.waitTimers.has("same"));
  resetControlRuntime();
}

console.log("stop versus in-flight agent settlement:");
{
  const h = new ResumeHarness({ prOpen: false, agentSteps: [{ delayMs: 40 }] });
  try {
    mkdirSync(join(h.root, ".worktree", h.change, "openspec", "changes", h.change), { recursive: true });
    h.persist(h.state({ phase: "build", inner: "build_implement", prNum: 0, head: "", stopReason: "stopped" }));
    const resume = h.resume();
    while (h.agentPrompts.length === 0) {await sleep(1);}
    applyControl(h.ctx, "stop");
    await resume;
    const state = h.stateExists() ? readLoopState(h.root, h.change) : null;
    check("stop during agent turn persists a stopped boundary", state?.stopReason === "stopped");
    check("agent settlement after stop does not push or create a PR", !h.commands.some((call) => call[0] === "git" && call[1] === "push") && !h.commands.some((call) => call[0] === "gh" && call[2] === "create"));
    check("stopped run releases the project lock", !existsSync(join(h.root, ".dev-loop.lock")));
  } finally {h.dispose();}
}

resetControlRuntime();
console.log(`\nALL ${passed} CONTROL/TIME RACE CHECKS PASSED`);
