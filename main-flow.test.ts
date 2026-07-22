import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PHASE, REVIEW_INNER } from "./src/lifecycle-state.ts";
import { ResumeHarness } from "./resume-test-harness.ts";

const prepareChange = (h: ResumeHarness, change: string): void => {
  mkdirSync(join(h.root, "openspec", "changes", change), { recursive: true });
};

async function freshTodoRunsEndToEnd(): Promise<void> {
  const h = new ResumeHarness({ prOpen: false, statusDirty: true });
  try {
    prepareChange(h, h.change);
    writeFileSync(join(h.root, "TODO.md"), `- [ ] ${h.change}\n`);
    h.track("TODO.md");
    await h.run("");
    assert.match(readFileSync(join(h.root, "TODO.md"), "utf8"), /- \[x\] test-change/);
    assert.equal(h.stateExists(), false);
    assert.ok(h.agentPrompts.some((prompt) => prompt.startsWith("Implement")));
    assert.ok(h.commands.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create"));
  } finally {h.dispose();}
}

async function allChainsEveryTodo(): Promise<void> {
  const h = new ResumeHarness({ prOpen: false, statusDirty: true });
  try {
    const second = "second-change";
    prepareChange(h, h.change); prepareChange(h, second);
    writeFileSync(join(h.root, "TODO.md"), `- [ ] ${h.change}\n- [ ] ${second}\n`);
    h.track("TODO.md");
    await h.run("--all");
    const todo = readFileSync(join(h.root, "TODO.md"), "utf8");
    assert.match(todo, /- \[x\] test-change/);
    assert.match(todo, /- \[x\] second-change/);
    assert.equal(h.agentPrompts.filter((prompt) => prompt.startsWith("Implement")).length, 2);
  } finally {h.dispose();}
}

async function dryRunLeavesOnlyWorktreeChanges(): Promise<void> {
  const h = new ResumeHarness({ prOpen: false });
  try {
    prepareChange(h, h.change);
    await h.run(`${h.change} --dry-run`);
    assert.equal(h.agentPrompts.length, 1);
    assert.equal(h.commands.some((call) => call[0] === "git" && call[1] === "push"), false);
    assert.equal(h.commands.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create"), false);
    assert.equal(existsSync(join(h.root, ".worktree", h.change)), true);
  } finally {h.dispose();}
}

async function oneOffDoesNotMarkTodo(): Promise<void> {
  const h = new ResumeHarness({ prOpen: false, statusDirty: true });
  try {
    prepareChange(h, h.change);
    writeFileSync(join(h.root, "TODO.md"), `- [ ] ${h.change}\n`);
    h.track("TODO.md");
    await h.run(h.change);
    assert.match(readFileSync(join(h.root, "TODO.md"), "utf8"), /- \[ \] test-change/);
  } finally {h.dispose();}
}

async function initIsIdempotent(): Promise<void> {
  const h = new ResumeHarness();
  try {
    rmSync(join(h.root, "openspec"), { recursive: true, force: true });
    await h.run("init");
    const firstCommits = h.commands.filter((call) => call[0] === "git" && call[1] === "commit").length;
    assert.equal(existsSync(join(h.root, "TODO.md")), true);
    assert.equal(existsSync(join(h.root, "openspec")), true);
    await h.run("init");
    assert.equal(h.commands.filter((call) => call[0] === "openspec" && call[1] === "init").length, 1);
    assert.equal(h.commands.filter((call) => call[0] === "git" && call[1] === "commit").length, firstCommits);
  } finally {h.dispose();}
}

async function statusReportsAllStates(): Promise<void> {
  const h = new ResumeHarness();
  try {
    h.persist(h.state({ phase: PHASE.REVIEW, inner: REVIEW_INNER.PROBE }), "change-a");
    h.persist(h.state({ phase: PHASE.ARCHIVE, inner: null, stopReason: null }), "change-b");
    await h.run("status");
    assert.ok(h.notifications.some((entry) => entry.message.includes('"change-a"') && entry.message.includes("STOPPED")));
    assert.ok(h.notifications.some((entry) => entry.message.includes('"change-b"') && entry.message.includes("idle")));
  } finally {h.dispose();}
}

await freshTodoRunsEndToEnd();
await allChainsEveryTodo();
await dryRunLeavesOnlyWorktreeChanges();
await oneOffDoesNotMarkTodo();
await initIsIdempotent();
await statusReportsAllStates();
console.log("ALL 6 MAIN FLOW GROUPS PASSED");
