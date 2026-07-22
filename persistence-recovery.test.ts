import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  reviewHistory: [], strategyEpoch: 0,
  stopReason: "stopped", stopSummary: null, oneOff: true,
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
  check("fills fields omitted by legacy REVIEW state", state?.inner === "review_reconcile" && state.round === 0 && state.suggestions.length === 0 && state.reviewHistory.length === 0 && state.strategyEpoch === 0 && !state.oneOff);
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
    reviewHistory: [
      { epoch: 0, round: 1, head: "abc", findings: [{ severity: "P2", title: "valid", path: "src/a.ts", line: 1 }] },
      { epoch: "bad", findings: [] },
    ],
  }));
  const state = readLoopState(root, change);
  check("filters malformed nested persisted values", state?.suggestions.length === 1 && state.seenSignatures.length === 1 && state.reviewHistory.length === 1);
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
  writeFileSync(join(root, `${LOOP_LOCK_FILE}.reclaim`), JSON.stringify({ pid: 2_147_483_647 }));
  rt.loopLockPath = null;
  check("malformed stale lock is reclaimed", acquireLoopLock(ctx));
  check("stale legacy recovery guard is removed", !existsSync(join(root, `${LOOP_LOCK_FILE}.reclaim`)));
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

console.log("concurrent stale-lock recovery:");
{
  const root = mkdtempSync(join(tmpdir(), "spec-loop-lock-race-"));
  const readyDir = join(root, "ready");
  const goPath = join(root, "go");
  mkdirSync(readyDir);
  writeFileSync(join(root, LOOP_LOCK_FILE), "stale-malformed-lock");
  writeFileSync(join(root, `${LOOP_LOCK_FILE}.reclaim`), "stale-recovery-guard");
  const controlUrl = pathToFileURL(join(process.cwd(), "src", "control.ts")).href;
  const worker = `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { acquireLoopLock, releaseLoopLock } from ${JSON.stringify(controlUrl)};
    const [root, id] = process.argv.slice(1);
    writeFileSync(join(root, "ready", id), "");
    while (!existsSync(join(root, "go"))) await new Promise((resolve) => setTimeout(resolve, 2));
    const acquired = acquireLoopLock({ cwd: root, ui: { notify() {} } });
    process.stdout.write(acquired ? "acquired" : "rejected");
    if (acquired) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      releaseLoopLock();
    }
  `;
  const children = Array.from({ length: 8 }, (_, index) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", worker, root, String(index)], { stdio: ["ignore", "pipe", "ignore"] });
    return new Promise<string>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {stdout += chunk.toString();});
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`lock worker exited ${code}`)));
    });
  });
  try {
    for (let tries = 0; tries < 500 && !Array.from({ length: 8 }, (_, index) => existsSync(join(readyDir, String(index)))).every(Boolean); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    writeFileSync(goPath, "");
    const results = await Promise.all(children);
    check("exactly one process acquires a concurrently reclaimed stale lock", results.filter((result) => result === "acquired").length === 1);
  } finally {rmSync(root, { recursive: true, force: true });}
}

console.log("process-crash lock recovery:");
{
  const root = mkdtempSync(join(tmpdir(), "spec-loop-lock-crash-"));
  const controlUrl = pathToFileURL(join(process.cwd(), "src", "control.ts")).href;
  const worker = `
    import { acquireLoopLock } from ${JSON.stringify(controlUrl)};
    const root = process.argv[1];
    if (!acquireLoopLock({ cwd: root, ui: { notify() {} } })) process.exit(2);
    process.stdout.write("acquired");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", worker, root], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`lock holder exited early ${code}`)));
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const ctx: LoopCtx = { cwd: root, ui: { notify: () => undefined } };
    rt.loopLockPath = null; rt.loopLockToken = null; rt.loopLockDb = null;
    check("OS transaction is recoverable after lock-holder process death", acquireLoopLock(ctx));
    releaseLoopLock();
  } finally {
    if (!child.killed) {child.kill("SIGKILL");}
    rmSync(root, { recursive: true, force: true });
  }
}

withRoot((root) => {
  const lockPath = join(root, LOOP_LOCK_FILE);
  const ctx: LoopCtx = { cwd: root, ui: { notify: () => undefined } };
  rt.loopLockPath = null;
  rt.loopLockToken = null;
  check("owner acquires lock before replacement check", acquireLoopLock(ctx));
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement-owner" }));
  releaseLoopLock();
  check("release does not delete a replacement owner's lock", existsSync(lockPath));
});

console.log(`\nALL ${passed} PERSISTENCE RECOVERY CHECKS PASSED`);
