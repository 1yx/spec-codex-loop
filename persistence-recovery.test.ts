import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLoopLock,
  readLoopState,
  releaseLoopLock,
  statePath,
  writeLoopState,
} from "./src/control.ts";
import { LOOP_LOCK_FILE, rt, type LoopCtx, type LoopState } from "./src/runtime.ts";
import { ResumeHarness } from "./resume-test-harness.ts";

let passed = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

const baseState = (): LoopState => ({
  phase: "review", inner: "review_probe", round: 1, prNum: 42,
  head: "abcdef1234567890", repo: "owner/repo", triggerAt: null,
  reviewDeadline: null, seenSignatures: [], suggestions: [], agentHead: null,
  stopReason: "stopped", oneOff: true,
});

function withRoot(run: (root: string, change: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "spec-loop-state-"));
  const change = "state-change";
  mkdirSync(join(root, ".worktree", change), { recursive: true });
  try {run(root, change);} finally {rmSync(root, { recursive: true, force: true });}
}

console.log("persisted state validation and compatibility:");
withRoot((root, change) => {
  const path = statePath(root, change);
  for (const invalid of ["{", "null", "[]", JSON.stringify({ phase: "future_phase" })]) {
    writeFileSync(path, invalid);
    check(`rejects invalid state ${invalid}`, readLoopState(root, change) === null);
  }
});

withRoot((root, change) => {
  writeFileSync(statePath(root, change), JSON.stringify({ phase: "review", stopReason: "stopped" }));
  const state = readLoopState(root, change);
  check("fills fields omitted by legacy REVIEW state", state?.inner === "review_reconcile" && state.round === 0 && state.suggestions.length === 0 && !state.oneOff);
});

withRoot((root, change) => {
  writeFileSync(statePath(root, change), JSON.stringify({ phase: "build", inner: "unknown_inner" }));
  check("repairs invalid inner state to the phase entry point", readLoopState(root, change)?.inner === "build_implement");
});

withRoot((root, change) => {
  writeFileSync(statePath(root, change), JSON.stringify({
    ...baseState(),
    suggestions: [{ severity: "P1", title: "valid", body: "fix", path: "src/a.ts", line: 1 }, { title: 7 }],
    seenSignatures: ["ok", 4],
  }));
  const state = readLoopState(root, change);
  check("filters malformed nested persisted values", state?.suggestions.length === 1 && state.seenSignatures.length === 1);
});

console.log("atomic state persistence:");
withRoot((root, change) => {
  const old = baseState();
  writeLoopState(root, change, old);
  mkdirSync(`${statePath(root, change)}.tmp`);
  writeLoopState(root, change, { ...old, round: 99 });
  check("failed temp write preserves prior state", readLoopState(root, change)?.round === 1);
});

withRoot((root, change) => {
  writeLoopState(root, change, baseState());
  writeFileSync(`${statePath(root, change)}.tmp`, "truncated");
  check("orphan temp file is ignored", readLoopState(root, change)?.phase === "review");
});

console.log("reality reconciliation:");
{
  const h = new ResumeHarness({ prOpen: false });
  try {
    h.prMerged = true;
    h.persist(h.state({ phase: "merge", inner: null }));
    await h.resume();
    check("persisted MERGE with already-merged PR proceeds to cleanup", !h.stateExists() && h.commands.some((call) => call.join(" ").includes("worktree remove")));
    check("cleanup releases repository lock", !existsSync(join(h.root, LOOP_LOCK_FILE)));
  } finally {h.dispose();}
}

console.log("project lock ownership:");
withRoot((root) => {
  const notices: string[] = [];
  const ctx: LoopCtx = { cwd: root, ui: { notify: (message) => notices.push(message) } };
  rt.loopLockPath = null;
  check("first loop instance acquires lock", acquireLoopLock(ctx));
  check("second loop instance in same runtime is rejected", !acquireLoopLock(ctx));
  releaseLoopLock();
  check("released lock can be acquired again", acquireLoopLock(ctx));
  releaseLoopLock();
});

withRoot((root) => {
  const ctx: LoopCtx = { cwd: root, ui: { notify: () => undefined } };
  writeFileSync(join(root, LOOP_LOCK_FILE), "not-json");
  rt.loopLockPath = null;
  check("malformed stale lock is reclaimed", acquireLoopLock(ctx));
  releaseLoopLock();
  writeFileSync(join(root, LOOP_LOCK_FILE), JSON.stringify({ pid: 2_147_483_647 }));
  check("dead-process lock is reclaimed", acquireLoopLock(ctx));
  releaseLoopLock();
});

{
  const root = mkdtempSync(join(tmpdir(), "spec-loop-live-lock-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    writeFileSync(join(root, LOOP_LOCK_FILE), JSON.stringify({ pid: child.pid }));
    const notices: string[] = [];
    const ctx: LoopCtx = { cwd: root, ui: { notify: (message) => notices.push(message) } };
    rt.loopLockPath = null;
    check("live foreign process lock is not stolen", !acquireLoopLock(ctx) && notices.some((message) => message.includes(String(child.pid))));
    check("foreign lock contents remain intact", JSON.parse(readFileSync(join(root, LOOP_LOCK_FILE), "utf8")).pid === child.pid);
  } finally {
    child.kill();
    rmSync(root, { recursive: true, force: true });
    rt.loopLockPath = null;
  }
}

console.log(`\nALL ${passed} PERSISTENCE RECOVERY CHECKS PASSED`);
