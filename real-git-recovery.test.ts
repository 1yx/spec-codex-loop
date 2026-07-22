import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { reconcileBranch } from "./src/git-utils.ts";

const execFile = promisify(execFileCallback);

class GitFixture {
  readonly root = mkdtempSync(join(tmpdir(), "spec-loop-git-"));
  readonly remote = join(this.root, "remote.git");
  readonly seed = join(this.root, "seed");
  readonly local = join(this.root, "local");
  readonly peer = join(this.root, "peer");
  readonly change = "change";

  constructor() {
    this.git(this.root, "init", "--bare", this.remote);
    this.git(this.root, "init", "-b", "main", this.seed);
    this.configure(this.seed);
    writeFileSync(join(this.seed, "conflict.txt"), "base\n");
    this.git(this.seed, "add", "."); this.git(this.seed, "commit", "-m", "initial");
    this.git(this.seed, "remote", "add", "origin", this.remote);
    this.git(this.seed, "push", "-u", "origin", "main");
    this.git(this.remote, "symbolic-ref", "HEAD", "refs/heads/main");
    this.git(this.seed, "checkout", "-b", this.change);
    this.git(this.seed, "push", "-u", "origin", this.change);
    this.git(this.root, "clone", this.remote, this.local);
    this.git(this.root, "clone", this.remote, this.peer);
    for (const repo of [this.local, this.peer]) {
      this.configure(repo);
      this.git(repo, "checkout", this.change);
    }
  }

  adapter(mergeableState = "clean", ambiguousPush = false): ExtensionAPI {
    let failPush = ambiguousPush;
    return {
      exec: async (command: string, args: string[], options?: { cwd?: string }) => {
        if (command === "gh") {return { code: 0, stdout: mergeableState, stderr: "" };}
        try {
          const result = await execFile(command, args, { cwd: options?.cwd });
          if (command === "git" && args[0] === "push" && failPush) {
            failPush = false;
            return { code: 1, stdout: result.stdout, stderr: "connection dropped after receive" };
          }
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const failure = error as { code?: number; stdout?: string; stderr?: string };
          return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
        }
      },
    } as unknown as ExtensionAPI;
  }

  commit(repo: string, file: string, content: string): string {
    appendFileSync(join(repo, file), content);
    this.git(repo, "add", file); this.git(repo, "commit", "-m", `${file} update`);
    return this.output(repo, "rev-parse", "HEAD");
  }

  output(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  dispose(): void {rmSync(this.root, { recursive: true, force: true });}

  private configure(repo: string): void {
    this.git(repo, "config", "user.email", "test@example.com");
    this.git(repo, "config", "user.name", "Test User");
  }
}

const ids = (f: GitFixture) => ({ repo: "owner/repo", prNum: 42, wtDir: f.local, change: f.change });

async function localAheadPushes(): Promise<void> {
  const f = new GitFixture();
  try {
    const head = f.commit(f.local, "local.txt", "local\n");
    const result = await reconcileBranch(f.adapter(), ids(f));
    assert.equal(result.kind, "ok");
    assert.equal(f.output(f.remote, "rev-parse", `refs/heads/${f.change}`), head);
  } finally {f.dispose();}
}

async function remoteAheadFastForwards(): Promise<void> {
  const f = new GitFixture();
  try {
    const head = f.commit(f.peer, "remote.txt", "remote\n");
    f.git(f.peer, "push");
    const result = await reconcileBranch(f.adapter(), ids(f));
    assert.equal(result.kind, "ok");
    assert.equal(f.output(f.local, "rev-parse", "HEAD"), head);
  } finally {f.dispose();}
}

async function divergenceStops(): Promise<void> {
  const f = new GitFixture();
  try {
    f.commit(f.local, "local.txt", "local\n");
    f.commit(f.peer, "remote.txt", "remote\n"); f.git(f.peer, "push");
    assert.deepEqual(await reconcileBranch(f.adapter(), ids(f)), { kind: "diverged" });
  } finally {f.dispose();}
}

async function mainCleanMerge(): Promise<void> {
  const f = new GitFixture();
  try {
    f.git(f.peer, "checkout", "main");
    const mainHead = f.commit(f.peer, "main.txt", "main\n"); f.git(f.peer, "push");
    const result = await reconcileBranch(f.adapter("behind"), ids(f));
    assert.equal(result.kind, "main_merged_clean");
    f.git(f.local, "merge-base", "--is-ancestor", mainHead, "HEAD");
  } finally {f.dispose();}
}

async function mainConflictAbortsMerge(): Promise<void> {
  const f = new GitFixture();
  try {
    writeFileSync(join(f.local, "conflict.txt"), "change\n");
    f.git(f.local, "add", "."); f.git(f.local, "commit", "-m", "change side"); f.git(f.local, "push");
    f.git(f.peer, "checkout", "main");
    writeFileSync(join(f.peer, "conflict.txt"), "main\n");
    f.git(f.peer, "add", "."); f.git(f.peer, "commit", "-m", "main side"); f.git(f.peer, "push");
    assert.deepEqual(await reconcileBranch(f.adapter("behind"), ids(f)), { kind: "main_conflict" });
    assert.equal(f.output(f.local, "status", "--porcelain"), "");
  } finally {f.dispose();}
}

async function ambiguousPushRecoversIdempotently(): Promise<void> {
  const f = new GitFixture();
  try {
    const head = f.commit(f.local, "local.txt", "local\n");
    const first = await reconcileBranch(f.adapter("clean", true), ids(f));
    assert.equal(first.kind, "sync_push_failed");
    assert.equal(f.output(f.remote, "rev-parse", `refs/heads/${f.change}`), head);
    assert.equal((await reconcileBranch(f.adapter(), ids(f))).kind, "ok");
  } finally {f.dispose();}
}

await localAheadPushes();
await remoteAheadFastForwards();
await divergenceStops();
await mainCleanMerge();
await mainConflictAbortsMerge();
await ambiguousPushRecoversIdempotently();
console.log("ALL 6 REAL GIT RECOVERY SCENARIOS PASSED");
