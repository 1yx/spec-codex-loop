import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { WORKTREE_ROOT, type LoopCtx, type ReconcileResult } from "./runtime.ts";

/** Run a command via pi.exec, optionally in cwd; returns trimmed stdout + exit code. */
export async function run(
  pi: ExtensionAPI,
  argv: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await pi.exec(argv[0], argv.slice(1), cwd ? { cwd } : undefined);
  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    code: r.code ?? 0,
  };
}

/**
 * GET a GitHub API endpoint as parsed JSON, or null on error/empty.
 */
export async function ghJson<T>(pi: ExtensionAPI, endpoint: string): Promise<T | null> {
  const { stdout, code } = await run(pi, ["gh", "api", endpoint]);
  if (code !== 0 || !stdout) {return null;}
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

// --- TODO.md checkbox parse + flip --------------------------------------------
/** Find the todo file case-insensitively (todo.md / TODO.md / …). */
export function findTodoFile(cwd: string): string | null {
  try {
    for (const entry of readdirSync(cwd)) {
      if (entry.toLowerCase() === "todo.md") {return join(cwd, entry);}
    }
  } catch {
    /* not a dir / unreadable */
  }
  return null;
}

/** First unchecked `- [ ] <change>` line (1-indexed) or null. */
export function pickTask(cwd: string): { lineNo: number; text: string } | null {
  const file = findTodoFile(cwd);
  if (!file) {return null;}
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*\[\s\]\s+(.+?)\s*$/);
    if (m) {return { lineNo: i + 1, text: m[1].trim() };}
  }
  return null;
}

/** Flip a specific todo line from `- [ ]` to `- [x]`. */
export function markDone(cwd: string, lineNo: number): void {
  const file = findTodoFile(cwd);
  if (!file) {return;}
  const lines = readFileSync(file, "utf-8").split("\n");
  if (lineNo >= 1 && lineNo <= lines.length) {
    lines[lineNo - 1] = lines[lineNo - 1].replace(/-\s*\[\s\]/, "- [x]");
    writeFileSync(file, lines.join("\n"));
  }
}

/** Ensure <change> is an unchecked `- [ ]` line in the todo file; return its 1-indexed line number. */
export function ensureTodoEntry(cwd: string, change: string): number {
  const file = findTodoFile(cwd) ?? join(cwd, "TODO.md");
  const raw = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const lines = raw.split("\n");
  const matches = (l: string) => {
    const m = l.match(/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/);
    return !!m && m[1].trim() === change;
  };
  const idx = lines.findIndex(matches);
  if (idx >= 0) {return idx + 1;}
  const prefix = raw && !raw.endsWith("\n") ? "\n" : "";
  writeFileSync(file, `${raw}${prefix}- [ ] ${change}\n`);
  return raw.split("\n").length + (prefix ? 1 : 0);
}

/** Find the change's checkbox line and flip it to [x]. */
export function markChangeDone(cwd: string, change: string): void {
  const t = pickTask(cwd);
  if (t && t.text === change) {markDone(cwd, t.lineNo);}
  else {markDone(cwd, ensureTodoEntry(cwd, change));}
}

// --- local gitignore + worktree helpers ---------------------------------------
/** Append `entry` to .git/info/exclude (local-only) if not already present. Best-effort. */
export async function ensureLocalIgnore(pi: ExtensionAPI, repoRoot: string, entry: string): Promise<void> {
  const { stdout: gitDir, code } = await run(pi, ["git", "rev-parse", "--git-dir"], repoRoot);
  if (code !== 0 || !gitDir) {return;}
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);
  const excludePath = join(absGitDir, "info", "exclude");
  try {
    const cur = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
    if (cur.split("\n").some((l) => l.trim() === entry)) {return;}
    const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, `${cur}${prefix}\n# spec-codex-loop (local-only)\n${entry}\n`);
  } catch {
    /* non-fatal */
  }
}

/** Remove `entry` from .git/info/exclude if present — undoes an earlier
 *  local-ignore so the file can be tracked/committed. Best-effort. */
export async function removeFromLocalIgnore(pi: ExtensionAPI, repoRoot: string, entry: string): Promise<void> {
  const { stdout: gitDir, code } = await run(pi, ["git", "rev-parse", "--git-dir"], repoRoot);
  if (code !== 0 || !gitDir) {return;}
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(repoRoot, gitDir);
  const excludePath = join(absGitDir, "info", "exclude");
  try {
    if (!existsSync(excludePath)) {return;}
    const cur = readFileSync(excludePath, "utf-8");
    if (!cur.split("\n").some((l) => l.trim() === entry)) {return;}
    writeFileSync(excludePath, cur.split("\n").filter((l) => l.trim() !== entry).join("\n"));
  } catch {
    /* non-fatal */
  }
}

/** Copy `.env*` files from the main repo into the worktree at the same relative
 *  path (nearly always gitignored, so the origin/main checkout is missing them).
 *  Walks the whole tree (monorepo), skipping .git/node_modules/.worktree. */
export function copyEnvFiles(repoRoot: string, wtDir: string): number {
  const isEnv = (name: string) => name === ".env" || name.startsWith(".env.");
  const skip = new Set([".git", "node_modules", WORKTREE_ROOT]);
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) {continue;}
        walk(join(dir, e.name));
      } else if (isEnv(e.name)) {
        const dest = join(wtDir, relative(repoRoot, join(dir, e.name)));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(dir, e.name), dest);
        n++;
      }
    }
  };
  walk(repoRoot);
  return n;
}

/** Remove a change's worktree + its local branch. Best-effort. */
export async function removeWorktree(pi: ExtensionAPI, repoRoot: string, change: string): Promise<void> {
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  await run(pi, ["git", "worktree", "remove", "--force", wtDir], repoRoot);
  await run(pi, ["git", "branch", "-D", change], repoRoot);
}

/** Fast-forward local main to origin/main once a PR's squash-merge lands, so the
 *  working tree reflects the merged change. Confirms/switches to main first
 *  (best-effort). A local-only untracked TODO.md is dropped (lossless — the
 *  incoming copy is a superset). Non-fast-forwardable main warns. */
export async function syncMain(pi: ExtensionAPI, ctx: LoopCtx, repoRoot: string): Promise<void> {
  await run(pi, ["git", "fetch", "origin", "main"], repoRoot);
  const { stdout: branch } = await run(pi, ["git", "rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (branch !== "main") {
    const { code, stderr } = await run(pi, ["git", "checkout", "main"], repoRoot);
    if (code !== 0) {
      ctx.ui.notify(`dev-loop: on ${branch}, couldn't switch to main (${stderr}); merge origin/main manually`, "warning");
      return;
    }
    ctx.ui.notify(`dev-loop: ${branch} → main`, "info");
  }
  const rootTodo = findTodoFile(repoRoot);
  if (rootTodo) {
    const { stdout } = await run(pi, ["git", "ls-files", "--", relative(repoRoot, rootTodo)], repoRoot);
    if (!stdout) { try { unlinkSync(rootTodo); } catch { /* best-effort */ } }
  }
  const { code, stderr } = await run(pi, ["git", "merge", "--ff-only", "origin/main"], repoRoot);
  if (code !== 0) {ctx.ui.notify(`dev-loop: local main can't fast-forward to origin/main (${stderr}); merge manually`, "warning");}
}

// --- origin reconciliation (change branch + main) ------------------------------
/** Reconcile the change branch with origin: sync origin/<change> (ff-push or
 *  detect divergence), then check GitHub's authoritative `mergeable_state` for
 *  whether main advanced. `behind` → clean main merge (auto-committed, caller
 *  pushes); `dirty` → conflict (caller hands to an agent turn with the change's
 *  context); `clean`/`unknown`/else → nothing to do now. */
export async function reconcileBranch(pi: ExtensionAPI, ids: { repo: string; prNum: number; wtDir: string; change: string }): Promise<ReconcileResult> {
  const { repo, prNum, wtDir, change } = ids;
  await run(pi, ["git", "fetch", "origin", "main", change], wtDir);
  const { stdout: localHead } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
  const { stdout: remoteHead } = await run(pi, ["git", "rev-parse", `origin/${change}`], wtDir);
  if (remoteHead && localHead && remoteHead !== localHead) {
    const { code: ffCode } = await run(pi, ["git", "merge-base", "--is-ancestor", remoteHead, localHead], wtDir);
    if (ffCode === 0) {
      const { code, stderr } = await run(pi, ["git", "push"], wtDir);
      if (code !== 0) {return { kind: "sync_push_failed", stderr };}
    } else {
      return { kind: "diverged" };
    }
  }
  const { stdout: ms } = await run(pi, ["gh", "api", `repos/${repo}/pulls/${prNum}`, "-q", ".mergeable_state"]);
  const state = ms.trim().toLowerCase();
  if (state === "behind") {
    const { code } = await run(pi, ["git", "merge", "origin/main", "--no-edit"], wtDir);
    if (code === 0) {
      const { stdout: head } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
      return { kind: "main_merged_clean", head };
    }
    await run(pi, ["git", "merge", "--abort"], wtDir);
    return { kind: "main_conflict" };
  }
  if (state === "dirty") {
    return { kind: "main_conflict" };
  }
  return { kind: "ok", head: localHead };
}

/**
 * Discriminated PR state for a change branch — when open/merged, prNum is a real number
 * (so callers narrow without a cast after checking `open`/`merged`).
 */
export type PrState =
  | { open: true; merged: false; prNum: number }
  | { open: false; merged: true; prNum: number }
  | { open: false; merged: false; prNum: null };

/** Open/merged PR state for a change's head branch (used for resume). When open
 *  or merged, prNum is a real number (discriminated — no narrowing casts needed). */
export async function prStateFor(
  pi: ExtensionAPI,
  repo: string,
  change: string
): Promise<PrState> {
  const lookup = async (state: string) => {
    const { stdout } = await run(pi, ["gh", 
      "pr", "list", "--head", change, "--state", state, "--json", "number", "-q", ".[0].number", "--repo", repo,
    ]);
    return parseInt((stdout || "").trim(), 10) || null;
  };
  const openNum = await lookup("open");
  if (openNum) {return { open: true, merged: false, prNum: openNum };}
  const mergedNum = await lookup("merged");
  if (mergedNum) {return { open: false, merged: true, prNum: mergedNum };}
  return { open: false, merged: false, prNum: null };
}
