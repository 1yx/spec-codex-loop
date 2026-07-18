import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BUILD_INNER, PHASE, REVIEW_INNER } from "./lifecycle-state.ts";
import {
  FETCH_SENTINEL,
  LOOP_STATE_FILE,
  REVIEW_TOTAL_TIMEOUT_MS,
  REVIEW_WAIT_MS,
  STOP_SENTINEL,
  WORKTREE_ROOT,
  yieldTick,
  rt,
} from "./runtime.ts";
import type { LoopCtx, LoopState } from "./runtime.ts";
import {
  copyEnvFiles,
  ensureLocalIgnore,
  findTodoFile,
  markChangeDone,
  pickTask,
  prStateFor,
  reconcileBranch,
  removeWorktree,
  run,
  syncMain,
} from "./git-utils.ts";
import { latestCommentAt, readCodexVerdict, shortSha, suggestionKey } from "./codex.ts";
import { buildImplement, fixPhase, resolveMainPhase } from "./phases.ts";
import { clearLoopState, readLoopState, scheduleWait, stopSentinelTicker, waitAction, writeLoopState } from "./control.ts";

type StepOutcome = "cont" | "suspend" | "done" | "stop";

type PrefixResult =
  | { kind: "atReview"; prNum: number; head: string; repo: string }
  | { kind: "atBuild"; repo: string }
  | { kind: "merged" }
  | { kind: "abort" }
  | { kind: "dryRun" };

/** Resolve → provision (worktree + env + openspec). Never blocks on a poll;
 *  returns at the review/build boundary. */
/** Create/reuse the change's worktree and seed it (env files, openspec, TODO).
 *  Returns "abort" if worktree creation or change lookup fails. */
async function provisionWorktree(pi: ExtensionAPI, ctx: LoopCtx, change: string, repoRoot: string, wtDir: string): Promise<"ok" | "abort"> {
  if (!existsSync(wtDir)) {
    const { stderr: fetchErr, code: fetchCode } = await run(pi, "git", ["fetch", "origin", "main"], repoRoot);
    if (fetchCode !== 0) {
      ctx.ui.notify(`dev-loop: git fetch origin main failed: ${fetchErr}`, "error");
      return "abort";
    }
    const { stderr: wtErr, code: wtCode } = await run(pi, "git", ["worktree", "add", "-b", change, wtDir, "origin/main"], repoRoot);
    if (wtCode !== 0) {
      ctx.ui.notify(`dev-loop: git worktree add failed: ${wtErr}`, "error");
      return "abort";
    }
  } else {
    ctx.ui.notify(`dev-loop: resuming — reusing worktree ${wtDir}`, "info");
  }
  const envCopied = copyEnvFiles(repoRoot, wtDir);
  if (envCopied) ctx.ui.notify(`dev-loop: copied ${envCopied} env file(s) (.env*) into worktree`, "info");
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (!existsSync(join(wtDir, "openspec"))) {
    cpSync(join(repoRoot, "openspec"), join(wtDir, "openspec"), { recursive: true });
    ctx.ui.notify("dev-loop: no openspec/ in worktree — copied openspec/ from main repo", "info");
  } else if (!existsSync(wtChangeDir)) {
    const srcChangeDir = join(repoRoot, "openspec", "changes", change);
    if (!existsSync(srcChangeDir)) {
      ctx.ui.notify(`dev-loop: openspec change "${change}" not found under openspec/changes/; aborting`, "error");
      await removeWorktree(pi, repoRoot, change);
      return "abort";
    }
    cpSync(srcChangeDir, wtChangeDir, { recursive: true });
    await run(pi, "git", ["add", `openspec/changes/${change}`], wtDir);
    await run(pi, "git", ["commit", "-m", `spec: add ${change} change`], wtDir);
  }
  const rootTodo = findTodoFile(repoRoot);
  if (rootTodo && !existsSync(join(wtDir, "TODO.md"))) cpSync(rootTodo, join(wtDir, "TODO.md"));
  return "ok";
}

export async function runPrefix(
  pi: ExtensionAPI,
  ctx: LoopCtx,
  change: string,
  dryRun: boolean
): Promise<PrefixResult> {
  const repoRoot = ctx.cwd as string;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  ctx.ui.notify(`dev-loop: change → ${change} (worktree ${wtDir})`, "info");

  // Fresh run: clear stale control flags + sentinels left by a previous run.
  rt.stopRequested = false;
  rt.fetchRequested = false;
  for (const s of [FETCH_SENTINEL, STOP_SENTINEL]) {
    try { unlinkSync(join(repoRoot, s)); } catch { /* already gone */ }
  }
  await ensureLocalIgnore(pi, repoRoot, `${WORKTREE_ROOT}/`);
  await ensureLocalIgnore(pi, repoRoot, FETCH_SENTINEL);
  await ensureLocalIgnore(pi, repoRoot, STOP_SENTINEL);
  await ensureLocalIgnore(pi, repoRoot, LOOP_STATE_FILE);

  const { stdout: repoOut } = await run(pi, "gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot);
  const repo = repoOut || "";
  if (!repo) {
    ctx.ui.notify("dev-loop: could not resolve repo via `gh repo view`", "error");
    return { kind: "abort" };
  }
  const pr = await prStateFor(pi, repo, change);

  if (pr.merged) {
    if (existsSync(wtDir)) await removeWorktree(pi, repoRoot, change);
    await syncMain(pi, ctx, repoRoot);
    ctx.ui.notify(`dev-loop: ${change} already merged in a prior run — cleaning up`, "info");
    return { kind: "merged" };
  }

  if ((await provisionWorktree(pi, ctx, change, repoRoot, wtDir)) === "abort") return { kind: "abort" };

  if (dryRun) {
    if (!pr.open) await buildImplement(pi, ctx, change, wtDir);
    ctx.ui.notify(`dev-loop: --dry-run → stopping (worktree left at ${wtDir})`, "info");
    return { kind: "dryRun" };
  }
  if (pr.open) {
    const prNum = pr.prNum as number;
    const { stdout: head } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
    ctx.ui.notify(`dev-loop: resuming — PR #${prNum} already open`, "info");
    return { kind: "atReview", prNum, head, repo };
  }
  return { kind: "atBuild", repo };
}

// --- oneStep: per-phase handlers ----------------------------------------------
async function handleBuild(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, wtDir: string, persist: () => void): Promise<StepOutcome> {
  if (s.inner === BUILD_INNER.IMPLEMENT) {
    await buildImplement(pi, ctx, change, wtDir);
    if (rt.stopRequested) {
      s.stopReason = "stopped"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: stopped during build — worktree left; use /loop resume`, "warning");
      persist(); return "stop";
    }
    s.inner = BUILD_INNER.PUSH; persist(); return "cont";
  }
  if (s.inner === BUILD_INNER.PUSH) {
    const { code, stderr } = await run(pi, "git", ["push", "-u", "origin", change], wtDir);
    if (code !== 0) {
      s.stopReason = "push_failed"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: git push failed (${stderr}); stopping — fix then /loop resume`, "error");
      persist(); return "stop";
    }
    s.inner = BUILD_INNER.PR; persist(); return "cont";
  }
  if (s.inner === BUILD_INNER.PR) {
    let pr = await prStateFor(pi, s.repo, change);
    if (!pr.open) {
      const { code, stderr } = await run(pi, "gh", ["pr", "create", "--title", change, "--head", change, "--body", `Implements OpenSpec change ${change}.`, "--repo", s.repo], wtDir);
      if (code !== 0) {
        s.stopReason = "pr_create_failed"; rt.interruptedChange = change;
        ctx.ui.notify(`dev-loop: gh pr create failed (${stderr}); stopping — fix then /loop resume`, "error");
        persist(); return "stop";
      }
      pr = await prStateFor(pi, s.repo, change);
    }
    if (!pr.open) {
      s.stopReason = "pr_create_failed"; rt.interruptedChange = change;
      ctx.ui.notify("dev-loop: gh pr create reported success but no open PR found; stopping", "error");
      persist(); return "stop";
    }
    const { stdout: head } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
    s.prNum = pr.prNum as number; s.head = head;
    s.phase = PHASE.REVIEW; s.inner = REVIEW_INNER.RECONCILE; s.round = 1;
    ctx.ui.notify(`dev-loop: PR #${s.prNum} — starting Codex review loop`, "info");
    persist(); return "cont";
  }
  s.stopReason = "bad_state"; persist(); return "stop";
}

async function handleReconcile(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, wtDir: string, persist: () => void): Promise<StepOutcome> {
  switch (waitAction(rt.fetchRequested, s.reviewDeadline, Date.now())) {
    case "recheck":
      rt.fetchRequested = false;
      ctx.ui.notify("dev-loop: fetch — rechecking Codex now", "info");
      break;
    case "timeout":
      s.stopReason = "timeout"; rt.interruptedChange = change;
      s.triggerAt = null; s.reviewDeadline = null;
      ctx.ui.notify(`dev-loop: no Codex review after ${REVIEW_TOTAL_TIMEOUT_MS / 60000}min on round ${s.round}; stopping (PR + worktree left)`, "warning");
      persist(); return "stop";
    default:
      break;
  }
  const r = await reconcileBranch(pi, s.repo, s.prNum, wtDir, change);
  if (r.kind === "diverged") {
    s.stopReason = "diverged"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: origin/${change} diverged from local; stopping — resolve then /loop resume`, "error");
    persist(); return "stop";
  }
  if (r.kind === "sync_push_failed") {
    s.stopReason = "sync_push_failed"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: sync push failed (${r.stderr}); stopping — fix then /loop resume`, "error");
    persist(); return "stop";
  }
  if (r.kind === "main_conflict") {
    s.inner = REVIEW_INNER.RESOLVE_MAIN; persist(); return "cont";
  }
  if (r.kind === "main_merged_clean") {
    const { code, stderr } = await run(pi, "git", ["push"], wtDir);
    if (code !== 0) {
      s.stopReason = "push_failed"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: push of main merge failed (${stderr}); stopping — fix then /loop resume`, "error");
      persist(); return "stop";
    }
    s.head = r.head; s.triggerAt = null; s.reviewDeadline = null;
    ctx.ui.notify(`dev-loop: merged origin/main (clean) on round ${s.round}; re-triggering @codex review on the merged head`, "info");
    s.inner = REVIEW_INNER.PROBE; persist(); return "cont";
  }
  s.head = r.head;
  s.inner = REVIEW_INNER.PROBE; persist(); return "cont";
}

async function handleResolveMain(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, wtDir: string, persist: () => void): Promise<StepOutcome> {
  await resolveMainPhase(pi, ctx, change, wtDir);
  if (rt.stopRequested) {
    s.stopReason = "stopped"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: stopped during main-merge resolution — PR + worktree left; use /loop resume`, "warning");
    persist(); return "stop";
  }
  const { stdout: unmerged } = await run(pi, "git", ["diff", "--name-only", "--diff-filter=U"], wtDir);
  if (unmerged) {
    s.stopReason = "main_conflict_unresolved"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: main-merge conflict not fully resolved (unmerged files remain); stopping — fix then /loop resume`, "error");
    persist(); return "stop";
  }
  const { stdout: head } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
  s.head = head; s.triggerAt = null; s.reviewDeadline = null;
  s.inner = REVIEW_INNER.RECONCILE; persist(); return "cont";
}

async function handleProbe(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, persist: () => void): Promise<StepOutcome> {
  const v = await readCodexVerdict(pi, s.repo, s.prNum, s.head, s.triggerAt);
  if (!v) {
    if (!s.triggerAt) { s.inner = REVIEW_INNER.TRIGGER; persist(); return "cont"; }
    s.inner = REVIEW_INNER.RECONCILE;
    ctx.ui.notify(`dev-loop: no Codex verdict on ${shortSha(s.head)} (round ${s.round}); waiting ${REVIEW_WAIT_MS / 60000}min — touch ${FETCH_SENTINEL} to recheck, /loop stop to stop`, "info");
    persist();
    scheduleWait(REVIEW_WAIT_MS);
    return "suspend";
  }
  if (v.unclassified) {
    s.stopReason = "codex_error"; rt.interruptedChange = change;
    s.triggerAt = null;
    ctx.ui.notify(`dev-loop: Codex replied with an unrecognized comment on round ${s.round} (likely an error); stopping — /loop resume re-triggers @codex review`, "warning");
    persist(); return "stop";
  }
  if (v.pass || v.suggestions.length === 0) {
    ctx.ui.notify(`dev-loop: Codex passed on round ${s.round}`, "info");
    s.phase = PHASE.ARCHIVE; s.inner = null; persist(); return "cont";
  }
  if (v.quotaExhausted) {
    s.stopReason = "quota"; rt.interruptedChange = change;
    s.triggerAt = null;
    ctx.ui.notify(`dev-loop: Codex review quota exhausted — stopping (PR + worktree left); /loop resume after it resets re-triggers @codex review`, "warning");
    persist(); return "stop";
  }
  const sig = suggestionKey(v.suggestions);
  if (s.seenSignatures.includes(sig)) {
    s.stopReason = "repeat"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: round ${s.round} repeats a prior review (fixes not landing); stopping (PR + worktree left)`, "warning");
    persist(); return "stop";
  }
  s.seenSignatures.push(sig);
  s.suggestions = v.suggestions;
  s.inner = REVIEW_INNER.FIX; persist(); return "cont";
}

async function handleTrigger(pi: ExtensionAPI, ctx: LoopCtx, s: LoopState, persist: () => void): Promise<StepOutcome> {
  const { code, stderr } = await run(pi, "gh", ["pr", "comment", String(s.prNum), "--body", "@codex review", "--repo", s.repo]);
  if (code !== 0) {
    s.stopReason = "trigger_failed";
    ctx.ui.notify(`dev-loop: trigger @codex review failed: ${stderr}`, "error");
    persist(); return "stop";
  }
  s.triggerAt = await latestCommentAt(pi, s.repo, s.prNum);
  s.reviewDeadline = Date.now() + REVIEW_TOTAL_TIMEOUT_MS;
  s.inner = REVIEW_INNER.PROBE;
  ctx.ui.notify(`dev-loop: round ${s.round} on ${shortSha(s.head)} — triggered @codex review, polling every ${REVIEW_WAIT_MS / 60000}min (≤${REVIEW_TOTAL_TIMEOUT_MS / 60000}min; touch ${FETCH_SENTINEL} to recheck)…`, "info");
  persist(); return "cont";
}

async function handleFix(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, wtDir: string, persist: () => void): Promise<StepOutcome> {
  const { stdout: headPre } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
  await fixPhase(pi, ctx, change, wtDir, s.prNum, s.round, s.suggestions);
  if (rt.stopRequested) {
    s.stopReason = "stopped"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: stopped during fix round ${s.round} — PR + worktree left; use /loop resume`, "warning");
    persist(); return "stop";
  }
  const { stdout: headPost } = await run(pi, "git", ["rev-parse", "HEAD"], wtDir);
  if (headPre === headPost) {
    s.stopReason = "no_progress"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: agent made no progress on round ${s.round}; stopping (PR + worktree left)`, "warning");
    persist(); return "stop";
  }
  const { code: pushCode, stderr: pushErr } = await run(pi, "git", ["push"], wtDir);
  if (pushCode !== 0) {
    s.stopReason = "push_failed"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: git push failed on round ${s.round} (${pushErr}); stopping — fix then /loop resume`, "error");
    persist(); return "stop";
  }
  s.round++;
  s.reviewDeadline = Date.now() + REVIEW_TOTAL_TIMEOUT_MS;
  s.inner = REVIEW_INNER.RECONCILE; persist(); return "cont";
}

async function handleReview(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, wtDir: string, persist: () => void): Promise<StepOutcome> {
  switch (s.inner) {
    case REVIEW_INNER.RECONCILE: return handleReconcile(pi, ctx, change, s, wtDir, persist);
    case REVIEW_INNER.RESOLVE_MAIN: return handleResolveMain(pi, ctx, change, s, wtDir, persist);
    case REVIEW_INNER.PROBE: return handleProbe(pi, ctx, change, s, persist);
    case REVIEW_INNER.TRIGGER: return handleTrigger(pi, ctx, s, persist);
    case REVIEW_INNER.FIX: return handleFix(pi, ctx, change, s, wtDir, persist);
    default: s.stopReason = "bad_state"; persist(); return "stop";
  }
}

async function handleArchive(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, wtDir: string, persist: () => void): Promise<StepOutcome> {
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (existsSync(wtChangeDir)) {
    const { code, stderr } = await run(pi, "openspec", ["archive", change, "-y"], wtDir);
    if (code !== 0) {
      s.stopReason = "archive_failed"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: openspec archive failed: ${stderr}; stopping (PR + worktree left)`, "warning");
      persist(); return "stop";
    }
    if (!s.oneOff) markChangeDone(wtDir, change);
    const { stdout: dirty } = await run(pi, "git", ["status", "--porcelain"], wtDir);
    if (dirty) {
      await run(pi, "git", ["add", "-A"], wtDir);
      await run(pi, "git", ["commit", "-m", `chore: archive ${change}`], wtDir);
      const { code: pc, stderr: pe } = await run(pi, "git", ["push"], wtDir);
      if (pc !== 0) {
        s.stopReason = "archive_push_failed"; rt.interruptedChange = change;
        ctx.ui.notify(`dev-loop: git push of archive commit failed (${pe}); stopping — fix then /loop resume`, "error");
        persist(); return "stop";
      }
    }
  }
  s.phase = PHASE.MERGE; persist(); return "cont";
}

async function handleMerge(pi: ExtensionAPI, ctx: LoopCtx, s: LoopState, persist: () => void): Promise<StepOutcome> {
  const { code, stderr } = await run(pi, "gh", ["pr", "merge", String(s.prNum), "--squash", "--delete-branch", "--repo", s.repo]);
  if (code !== 0) {
    s.stopReason = "merge_failed";
    ctx.ui.notify(`dev-loop: gh pr merge failed: ${stderr}`, "error");
    persist(); return "stop";
  }
  s.phase = PHASE.CLEANUP; persist(); return "cont";
}

async function handleCleanup(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState, repoRoot: string): Promise<StepOutcome> {
  await removeWorktree(pi, repoRoot, change);
  await syncMain(pi, ctx, repoRoot);
  return "done";
}

/** One state-machine transition. Mutates `s` and persists it. */
export async function oneStep(pi: ExtensionAPI, ctx: LoopCtx, change: string, s: LoopState): Promise<StepOutcome> {
  const repoRoot = ctx.cwd as string;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  const persist = () => writeLoopState(repoRoot, change, s);
  if (s.phase === PHASE.BUILD) return handleBuild(pi, ctx, change, s, wtDir, persist);
  if (s.phase === PHASE.REVIEW) return handleReview(pi, ctx, change, s, wtDir, persist);
  if (s.phase === PHASE.ARCHIVE) return handleArchive(pi, ctx, change, s, wtDir, persist);
  if (s.phase === PHASE.MERGE) return handleMerge(pi, ctx, s, persist);
  if (s.phase === PHASE.CLEANUP) return handleCleanup(pi, ctx, change, s, repoRoot);
  s.stopReason = "bad_state"; persist(); return "stop";
}

/** Drive one change from its persisted state to suspension or completion. */
export async function driveChange(
  pi: ExtensionAPI,
  ctx: LoopCtx,
  change: string,
  dryRun: boolean,
  oneOff: boolean
): Promise<"completed" | "suspended" | "stopped" | "aborted"> {
  const repoRoot = ctx.cwd as string;
  let s = readLoopState(repoRoot, change);
  // RESOLVE/PROVISION/no-state: re-derive via runPrefix. BUILD is a persisted
  // inner machine handled by oneStep, so a crashed BUILD state resumes there.
  if (!s || s.phase === PHASE.RESOLVE || s.phase === PHASE.PROVISION) {
    const r = await runPrefix(pi, ctx, change, dryRun);
    if (r.kind === "merged") return "completed";
    if (r.kind === "dryRun" || r.kind === "abort") return "aborted";
    if (r.kind === "atReview") {
      s = {
        phase: PHASE.REVIEW, inner: REVIEW_INNER.RECONCILE, round: 1,
        prNum: r.prNum, head: r.head, repo: r.repo,
        triggerAt: null, reviewDeadline: null, seenSignatures: [], suggestions: [], stopReason: null, oneOff,
      };
      writeLoopState(repoRoot, change, s);
    } else if (r.kind === "atBuild") {
      s = {
        phase: PHASE.BUILD, inner: BUILD_INNER.IMPLEMENT, round: 0,
        prNum: 0, head: "", repo: r.repo,
        triggerAt: null, reviewDeadline: null, seenSignatures: [], suggestions: [], stopReason: null, oneOff,
      };
      writeLoopState(repoRoot, change, s);
    }
  }
  // Reaching here means s is set (non-null path above returns or reassigns it);
  // guard for the type checker (PrefixResult is exhaustive, so this is unreachable).
  if (!s) return "aborted";
  while (true) {
    if (rt.stopRequested) { s.stopReason = "stopped"; writeLoopState(repoRoot, change, s); return "stopped"; }
    const out = await oneStep(pi, ctx, change, s);
    if (out === "suspend") return "suspended";
    if (out === "done") return "completed";
    if (out === "stop") return "stopped";
    await yieldTick();
  }
}

/** Re-entrant entry (the handler, the review_wait timer, and /loop fetch all
 *  call it). Walks steps until the current change suspends or finishes; for
 *  --all, chains the next TODO change. Owns loopActive + ticker lifecycle. */
export async function runLoopChain(): Promise<void> {
  if (!rt.piRef || !rt.runCtx || rt.stepping) return;
  const pi = rt.piRef;
  const ctx = rt.runCtx.ctx;
  rt.stepping = true;
  try {
    while (rt.runCtx) {
      if (rt.stopRequested) {
        const s = readLoopState(ctx.cwd as string, rt.runCtx.change);
        if (s) { s.stopReason = "stopped"; writeLoopState(ctx.cwd as string, rt.runCtx.change, s); }
        rt.interruptedChange = rt.runCtx.change;
        ctx.ui.notify(`dev-loop: stopped (PR + worktree left); use /loop resume`, "warning");
        rt.loopActive = false; stopSentinelTicker(); rt.runCtx = null;
        return;
      }
      const outcome = await driveChange(pi, ctx, rt.runCtx.change, rt.runCtx.dryRun, rt.runCtx.oneOff);
      if (outcome === "suspended") return;
      if (outcome === "completed") {
        clearLoopState(ctx.cwd as string, rt.runCtx.change);
        ctx.ui.notify(`dev-loop: "${rt.runCtx.change}" merged ✅`, "info");
        if (rt.runCtx.all && !rt.runCtx.oneOff) {
          const next = pickTask(ctx.cwd as string);
          if (next) { rt.runCtx = { ...rt.runCtx, change: next.text }; continue; }
        }
        rt.loopActive = false; stopSentinelTicker(); rt.runCtx = null;
        return;
      }
      if (outcome === "stopped") rt.interruptedChange = rt.runCtx.change;
      rt.loopActive = false; stopSentinelTicker(); rt.runCtx = null;
      return;
    }
  } finally {
    rt.stepping = false;
  }
}
