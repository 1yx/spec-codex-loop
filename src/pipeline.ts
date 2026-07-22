import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cpSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BUILD_INNER, PHASE, REVIEW_INNER } from "./lifecycle-state.ts";
import { stopForAgentFailure } from "./agent-turn.ts";
import { normalizeResumeState } from "./resume-state.ts";
import {
  FETCH_SENTINEL,
  LOOP_LOCK_FILE,
  LOOP_STATE_FILE,
  REVIEW_TOTAL_TIMEOUT_MS,
  REVIEW_WAIT_MS,
  STOP_SENTINEL,
  WORKTREE_ROOT,
  yieldTick,
  rt,
  type LoopCtx,
  type LoopState,
  type PhaseCtx,
  type StepCtx,
} from "./runtime.ts";
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
import { latestCommentAt, readCodexVerdict, reviewTriggerAt, shortSha, suggestionKey } from "./codex.ts";
import { buildImplement, fixPhase, resolveMainPhase } from "./phases.ts";
import { clearLoopState, readLoopState, releaseLoopLock, scheduleWait, stopSentinelTicker, waitAction, writeLoopState } from "./control.ts";

/**
 * Outcome of a oneStep transition: continue / suspend (review_wait) / done / stop.
 */
type StepOutcome = "cont" | "suspend" | "done" | "stop";

/**
 * Outcome of runPrefix (resolve+provision): enter at review/build, or terminal merged/dryRun/abort.
 */
type PrefixResult =
  | { kind: "atReview"; prNum: number; head: string; repo: string }
  | { kind: "atBuild"; repo: string }
  | { kind: "merged" }
  | { kind: "abort" }
  | { kind: "dryRun" };

/** Create/reuse the change's worktree. openspec/ is plain tracked content
 *  inherited from origin/main — no copy. The change's proposal must already
 *  be committed + pushed to main, else abort. Returns "ok"/"abort". */
async function provisionWorktree(p: PhaseCtx): Promise<"ok" | "abort"> {
  const { pi, ctx, change, wtDir } = p;
  const repoRoot = ctx.cwd;
  if (!existsSync(wtDir)) {
    const { stderr: fetchErr, code: fetchCode } = await run(pi, ["git", "fetch", "origin", "main"], repoRoot);
    if (fetchCode !== 0) {
      ctx.ui.notify(`dev-loop: git fetch origin main failed: ${fetchErr}`, "error");
      return "abort";
    }
    const { stderr: wtErr, code: wtCode } = await run(pi, ["git", "worktree", "add", "-b", change, wtDir, "origin/main"], repoRoot);
    if (wtCode !== 0) {
      ctx.ui.notify(`dev-loop: git worktree add failed: ${wtErr}`, "error");
      return "abort";
    }
  } else {
    ctx.ui.notify(`dev-loop: resuming — reusing worktree ${wtDir}`, "info");
  }
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (!existsSync(wtChangeDir)) {
    ctx.ui.notify(`dev-loop: openspec change "${change}" not on origin/main under openspec/changes/ — commit + push it to main first, then /loop resume`, "error");
    await removeWorktree(pi, repoRoot, change);
    return "abort";
  }
  const envCopied = copyEnvFiles(repoRoot, wtDir);
  if (envCopied) {ctx.ui.notify(`dev-loop: copied ${envCopied} env file(s) (.env*) into worktree`, "info");}
  const rootTodo = findTodoFile(repoRoot);
  if (rootTodo && !existsSync(join(wtDir, "TODO.md"))) {cpSync(rootTodo, join(wtDir, "TODO.md"));}
  return "ok";
}

/** Fresh-run setup: clear stale control flags + sentinels, and ensure the
 *  loop's artifacts are locally gitignored. */
async function clearRunArtifacts(pi: ExtensionAPI, repoRoot: string): Promise<void> {
  rt.stopRequested = false;
  rt.fetchRequested = false;
  for (const s of [FETCH_SENTINEL, STOP_SENTINEL]) {
    try { unlinkSync(join(repoRoot, s)); } catch { /* already gone */ }
  }
  await ensureLocalIgnore(pi, repoRoot, `${WORKTREE_ROOT}/`);
  await ensureLocalIgnore(pi, repoRoot, FETCH_SENTINEL);
  await ensureLocalIgnore(pi, repoRoot, STOP_SENTINEL);
  await ensureLocalIgnore(pi, repoRoot, LOOP_LOCK_FILE);
  await ensureLocalIgnore(pi, repoRoot, LOOP_STATE_FILE);
}

/** Resolve → provision (worktree + env + openspec). Never blocks on a poll;
 *  returns at the review/build boundary. Reads dryRun from rt.runCtx. */
export async function runPrefix(pi: ExtensionAPI, ctx: LoopCtx, change: string): Promise<PrefixResult> {
  const repoRoot = ctx.cwd;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  ctx.ui.notify(`dev-loop: change → ${change} (worktree ${wtDir})`, "info");
  await clearRunArtifacts(pi, repoRoot);

  const { stdout: repoOut } = await run(pi, ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], repoRoot);
  const repo = repoOut || "";
  if (!repo) {
    ctx.ui.notify("dev-loop: could not resolve repo via `gh repo view`", "error");
    return { kind: "abort" };
  }
  const pr = await prStateFor(pi, repo, change);
  if (pr.merged) {
    if (existsSync(wtDir)) {await removeWorktree(pi, repoRoot, change);}
    await syncMain(pi, ctx, repoRoot);
    ctx.ui.notify(`dev-loop: ${change} already merged in a prior run — cleaning up`, "info");
    return { kind: "merged" };
  }
  if ((await provisionWorktree({ pi, ctx, change, wtDir })) === "abort") {return { kind: "abort" };}
  if (rt.runCtx?.dryRun) {
    if (!pr.open) {await buildImplement({ pi, ctx, change, wtDir });}
    ctx.ui.notify(`dev-loop: --dry-run → stopping (worktree left at ${wtDir})`, "info");
    return { kind: "dryRun" };
  }
  if (pr.open) {
    const prNum = pr.prNum;
    const { stdout: head } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
    ctx.ui.notify(`dev-loop: resuming — PR #${prNum} already open`, "info");
    return { kind: "atReview", prNum, head, repo };
  }
  return { kind: "atBuild", repo };
}

// --- oneStep: per-phase handlers ----------------------------------------------
/**
 * BUILD inner: implement → push → pr (one persisted transition each).
 */
async function handleBuild(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, wtDir, persist } = step;
  if (s.inner === BUILD_INNER.IMPLEMENT) {
    const turn = await buildImplement({ pi, ctx, change, wtDir });
    if (rt.stopRequested) {
      s.stopReason = "stopped"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: stopped during build — worktree left; use /loop resume`, "info");
      persist(); return "stop";
    }
    if (!turn.ok) {return stopForAgentFailure(step, turn.error);}
    s.inner = BUILD_INNER.PUSH; persist(); return "cont";
  }
  if (s.inner === BUILD_INNER.PUSH) {
    const { code, stderr } = await run(pi, ["git", "push", "-u", "origin", change], wtDir);
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
      const { code, stderr } = await run(pi, ["gh", "pr", "create", "--title", change, "--head", change, "--body", `Implements OpenSpec change ${change}.`, "--repo", s.repo], wtDir);
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
    const { stdout: head } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
    s.prNum = pr.prNum; s.head = head;
    s.phase = PHASE.REVIEW; s.inner = REVIEW_INNER.RECONCILE; s.round = 1;
    ctx.ui.notify(`dev-loop: PR #${s.prNum} — starting Codex review loop`, "info");
    persist(); return "cont";
  }
  s.stopReason = "bad_state"; persist(); return "stop";
}

/**
 * REVIEW/RECONCILE: wake-decision + sync origin/<change> + merge origin/main when behind.
 */
async function handleReconcile(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, wtDir, persist } = step;
  switch (waitAction(rt.fetchRequested, s.reviewDeadline, Temporal.Now.instant().epochMilliseconds)) {
    case "recheck":
      rt.fetchRequested = false;
      ctx.ui.notify("dev-loop: fetch — rechecking Codex now", "info");
      break;
    case "timeout":
      s.stopReason = "timeout"; rt.interruptedChange = change;
      s.triggerAt = null; s.reviewDeadline = null;
      ctx.ui.notify(`dev-loop: no Codex review after ${REVIEW_TOTAL_TIMEOUT_MS / 60000}min on round ${s.round}; stopping (PR + worktree left)`, "info");
      persist(); return "stop";
    default:
      break;
  }
  const r = await reconcileBranch(pi, { repo: s.repo, prNum: s.prNum, wtDir, change });
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
    const { code, stderr } = await run(pi, ["git", "push"], wtDir);
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

/**
 * REVIEW/RESOLVE_MAIN: agent resolves origin/main conflicts using both sides' context, then re-review.
 */
async function handleResolveMain(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, wtDir, persist } = step;
  const turn = await resolveMainPhase({ pi, ctx, change, wtDir });
  if (rt.stopRequested) {
    s.stopReason = "stopped"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: stopped during main-merge resolution — PR + worktree left; use /loop resume`, "info");
    persist(); return "stop";
  }
  if (!turn.ok) {return stopForAgentFailure(step, turn.error);}
  const { stdout: unmerged } = await run(pi, ["git", "diff", "--name-only", "--diff-filter=U"], wtDir);
  if (unmerged) {
    s.stopReason = "main_conflict_unresolved"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: main-merge conflict not fully resolved (unmerged files remain); stopping — fix then /loop resume`, "error");
    persist(); return "stop";
  }
  const { stdout: head } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
  s.head = head; s.triggerAt = null; s.reviewDeadline = null;
  s.inner = REVIEW_INNER.RECONCILE; persist(); return "cont";
}

/**
 * REVIEW/PROBE: read Codex's verdict for the head → pass/quota/unclassified/suggestions, else sleep.
 */
async function handleProbe(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, persist } = step;
  // Gate: if local head isn't the PR's remote head, Codex can never produce a
  //  verdict for s.head (GitHub has no such commit) and we'd loop forever
  //  re-triggering @codex review. Stop so the user pushes, then /loop resume.
  //  gh itself failing (network/auth) is skipped so it can't false-trip this.
  const { stdout: remoteHead, code: rhCode } = await run(pi, ["gh", "pr", "view", String(s.prNum), "--repo", s.repo, "--json", "headRefOid", "-q", ".headRefOid"]);
  if (rhCode === 0 && shortSha(remoteHead) !== shortSha(s.head)) {
    s.stopReason = "head_not_pushed"; rt.interruptedChange = change;
    s.triggerAt = null; s.reviewDeadline = null;
    ctx.ui.notify(`dev-loop: local head ${shortSha(s.head)} ≠ PR head ${shortSha(remoteHead)} — push, then /loop resume`, "error");
    persist(); return "stop";
  }
  const v = await readCodexVerdict(pi, { repo: s.repo, prNum: s.prNum, head: s.head, triggerAt: s.triggerAt });
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
    s.triggerAt = null; s.reviewDeadline = null;
    ctx.ui.notify(`dev-loop: Codex replied with an unrecognized comment on round ${s.round} (likely an error); stopping — /loop resume re-triggers @codex review`, "warning");
    persist(); return "stop";
  }
  if (v.quotaExhausted) {
    s.stopReason = "quota"; rt.interruptedChange = change;
    s.triggerAt = null; s.reviewDeadline = null;
    ctx.ui.notify(`dev-loop: Codex review quota exhausted — stopping (PR + worktree left); /loop resume after it resets re-triggers @codex review`, "info");
    persist(); return "stop";
  }
  if (v.pass) {
    ctx.ui.notify(`dev-loop: Codex passed on round ${s.round}`, "info");
    s.phase = PHASE.ARCHIVE; s.inner = null; persist(); return "cont";
  }
  const sig = suggestionKey(v.suggestions);
  if (s.seenSignatures.includes(sig)) {
    s.stopReason = "repeat"; rt.interruptedChange = change; s.triggerAt = null; s.reviewDeadline = null;
    ctx.ui.notify(`dev-loop: round ${s.round} repeats a prior review (fixes not landing); stopping (PR + worktree left)`, "warning");
    persist(); return "stop";
  }
  s.seenSignatures.push(sig);
  s.suggestions = v.suggestions;
  s.inner = REVIEW_INNER.FIX; persist(); return "cont";
}

/**
 * REVIEW/TRIGGER: post \@codex review, record triggerAt + a fresh review deadline.
 */
async function handleTrigger(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, s, persist } = step;
  let triggerAt = await reviewTriggerAt(pi, { repo: s.repo, prNum: s.prNum, head: s.head });
  if (!triggerAt) {
    const body = `@codex review\n<!-- spec-codex-loop:${s.head} -->`;
    const { code, stderr } = await run(pi, ["gh", "pr", "comment", String(s.prNum), "--body", body, "--repo", s.repo]);
    if (code !== 0) {
      s.stopReason = "trigger_failed";
      ctx.ui.notify(`dev-loop: trigger @codex review failed: ${stderr}`, "error");
      persist(); return "stop";
    }
    triggerAt = await latestCommentAt(pi, s.repo, s.prNum);
  }
  // latestCommentAt can return "" right after the post (GitHub eventual
  //  consistency on the issues/comments index, or an empty result). Fall back
  //  to local time so !s.triggerAt can never re-fire @codex review each cycle.
  s.triggerAt = triggerAt || Temporal.Now.instant().toString();
  s.reviewDeadline = Temporal.Now.instant().epochMilliseconds + REVIEW_TOTAL_TIMEOUT_MS;
  s.inner = REVIEW_INNER.PROBE;
  ctx.ui.notify(`dev-loop: round ${s.round} on ${shortSha(s.head)} — triggered @codex review, polling every ${REVIEW_WAIT_MS / 60000}min (≤${REVIEW_TOTAL_TIMEOUT_MS / 60000}min; touch ${FETCH_SENTINEL} to recheck)…`, "info");
  persist(); return "cont";
}

/**
 * REVIEW/FIX: agent addresses suggestions, push, round++, reset the deadline.
 */
async function handleFix(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, wtDir, persist } = step;
  if (!s.agentHead) {
    const { stdout } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
    s.agentHead = stdout;
    persist();
  }
  const turn = await fixPhase({ pi, ctx, change, wtDir }, s);
  if (rt.stopRequested) {
    s.stopReason = "stopped"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: stopped during fix round ${s.round} — PR + worktree left; use /loop resume`, "info");
    persist(); return "stop";
  }
  if (!turn.ok) {return stopForAgentFailure(step, turn.error);}
  const { stdout: headPost } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
  if (s.agentHead === headPost) {
    s.stopReason = "no_progress"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: agent made no progress on round ${s.round}; stopping (PR + worktree left)`, "warning");
    persist(); return "stop";
  }
  const { code: pushCode, stderr: pushErr } = await run(pi, ["git", "push"], wtDir);
  if (pushCode !== 0) {
    s.stopReason = "push_failed"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: git push failed on round ${s.round} (${pushErr}); stopping — fix then /loop resume`, "error");
    persist(); return "stop";
  }
  s.agentHead = null;
  s.round++;
  s.triggerAt = null;
  s.reviewDeadline = null;
  s.inner = REVIEW_INNER.RECONCILE; persist(); return "cont";
}

/**
 * REVIEW dispatch: route to the inner-state handler (reconcile/probe/trigger/fix/resolve-main).
 */
async function handleReview(step: StepCtx): Promise<StepOutcome> {
  const { s, persist } = step;
  switch (s.inner) {
    case REVIEW_INNER.RECONCILE: return handleReconcile(step);
    case REVIEW_INNER.RESOLVE_MAIN: return handleResolveMain(step);
    case REVIEW_INNER.PROBE: return handleProbe(step);
    case REVIEW_INNER.TRIGGER: return handleTrigger(step);
    case REVIEW_INNER.FIX: return handleFix(step);
    default: s.stopReason = "bad_state"; persist(); return "stop";
  }
}

/** Bring latest main into an approved head, requiring a new review if HEAD changes. */
async function reconcileMainBeforeArchive(step: StepCtx): Promise<StepOutcome | null> {
  const { pi, ctx, change, s, wtDir, persist } = step;
  const { code: fetchCode, stderr: fetchErr } = await run(pi, ["git", "fetch", "origin", "main"], wtDir);
  if (fetchCode !== 0) {
    s.stopReason = "archive_fetch_failed"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: fetch of origin/main before archive failed (${fetchErr}); stopping — /loop resume retries from archive`, "error");
    persist(); return "stop";
  }
  const { code: mc } = await run(pi, ["git", "merge", "origin/main", "--no-edit"], wtDir);
  if (mc !== 0) {
    await run(pi, ["git", "merge", "--abort"], wtDir);
    s.stopReason = "archive_main_conflict"; rt.interruptedChange = change;
    ctx.ui.notify(`dev-loop: origin/main conflicts before archive (round ${s.round}); stopping — resolve then /loop resume`, "warning");
    persist(); return "stop";
  }
  const { stdout: headAfterMerge } = await run(pi, ["git", "rev-parse", "HEAD"], wtDir);
  // Compare with the persisted approved head, not this invocation's pre-merge
  // head. A prior attempt may have merged main and then failed to push.
  if (headAfterMerge !== s.head) {
    const { code: rpc, stderr: rpe } = await run(pi, ["git", "push"], wtDir);
    if (rpc !== 0) {
      s.stopReason = "archive_push_failed"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: push of main-reconcile before archive failed (${rpe}); stopping — fix then /loop resume`, "error");
      persist(); return "stop";
    }
    s.phase = PHASE.REVIEW; s.inner = REVIEW_INNER.PROBE; s.head = headAfterMerge;
    s.triggerAt = null; s.reviewDeadline = null; s.suggestions = [];
    ctx.ui.notify(`dev-loop: origin/main changed the approved head to ${shortSha(s.head)}; returning to Codex review before archive`, "info");
    persist(); return "cont";
  }
  return null;
}

/**
 * ARCHIVE: openspec archive + mark TODO [x] + commit + push.
 */
async function handleArchive(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, wtDir, persist } = step;
  // PROBE→ARCHIVE skips RECONCILE. Verify latest main here, and if merging it
  // changes HEAD, send that new commit through Codex before archiving.
  const reconcileOutcome = await reconcileMainBeforeArchive(step);
  if (reconcileOutcome) {return reconcileOutcome;}
  const wtChangeDir = join(wtDir, "openspec", "changes", change);
  if (existsSync(wtChangeDir)) {
    const { code, stderr } = await run(pi, ["openspec", "archive", change, "-y"], wtDir);
    if (code !== 0) {
      s.stopReason = "archive_failed"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: openspec archive failed: ${stderr}; stopping (PR + worktree left)`, "warning");
      persist(); return "stop";
    }
  }
  // These steps also run when a previous process completed `openspec archive`
  // and crashed before committing its working-tree changes.
  if (!s.oneOff) {markChangeDone(wtDir, change);}
  const { stdout: dirty } = await run(pi, ["git", "status", "--porcelain"], wtDir);
  if (dirty) {
    await run(pi, ["git", "add", "-A"], wtDir);
    await run(pi, ["git", "commit", "-m", `chore: archive ${change}`], wtDir);
    const { code: pc, stderr: pe } = await run(pi, ["git", "push"], wtDir);
    if (pc !== 0) {
      s.stopReason = "archive_push_failed"; rt.interruptedChange = change;
      ctx.ui.notify(`dev-loop: git push of archive commit failed (${pe}); stopping — fix then /loop resume`, "error");
      persist(); return "stop";
    }
  }
  s.phase = PHASE.MERGE; persist(); return "cont";
}

/**
 * MERGE: gh pr merge --squash --delete-branch.
 */
async function handleMerge(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change, s, persist } = step;
  if ((await prStateFor(pi, s.repo, change)).merged) {
    s.phase = PHASE.CLEANUP; persist(); return "cont";
  }
  const { code, stderr } = await run(pi, ["gh", "pr", "merge", String(s.prNum), "--squash", "--delete-branch", "--repo", s.repo]);
  if (code !== 0) {
    if ((await prStateFor(pi, s.repo, change)).merged) {
      s.phase = PHASE.CLEANUP; persist(); return "cont";
    }
    s.stopReason = "merge_failed";
    ctx.ui.notify(`dev-loop: gh pr merge failed: ${stderr}`, "error");
    persist(); return "stop";
  }
  s.phase = PHASE.CLEANUP; persist(); return "cont";
}

/**
 * CLEANUP: remove worktree + sync local main (terminal).
 */
async function handleCleanup(step: StepCtx): Promise<StepOutcome> {
  const { pi, ctx, change } = step;
  await syncMain(pi, ctx, ctx.cwd);
  // State lives inside the worktree, so removal must be the final side effect.
  await removeWorktree(pi, ctx.cwd, change);
  return "done";
}

/** One state-machine transition. Dispatches to the per-phase handler. */
export async function oneStep(step: StepCtx): Promise<StepOutcome> {
  const { s, persist } = step;
  if (s.phase === PHASE.BUILD) {return handleBuild(step);}
  if (s.phase === PHASE.REVIEW) {return handleReview(step);}
  if (s.phase === PHASE.ARCHIVE) {return handleArchive(step);}
  if (s.phase === PHASE.MERGE) {return handleMerge(step);}
  if (s.phase === PHASE.CLEANUP) {return handleCleanup(step);}
  s.stopReason = "bad_state"; persist(); return "stop";
}

/**
 * resolveInitialState outcome: a LoopState to drive, or a terminal completed/aborted.
 */
type InitState = { s: LoopState } | "completed" | "aborted";

/**
 * Map an atReview/atBuild PrefixResult to the initial BUILD/REVIEW LoopState (null for terminal kinds).
 */
function seedFromPrefix(r: PrefixResult, oneOff: boolean): LoopState | null {
  if (r.kind === "atReview") {return { phase: PHASE.REVIEW, inner: REVIEW_INNER.RECONCILE, round: 1, prNum: r.prNum, head: r.head, repo: r.repo, triggerAt: null, reviewDeadline: null, seenSignatures: [], suggestions: [], stopReason: null, oneOff };}
  if (r.kind === "atBuild") {return { phase: PHASE.BUILD, inner: BUILD_INNER.IMPLEMENT, round: 0, prNum: 0, head: "", repo: r.repo, triggerAt: null, reviewDeadline: null, seenSignatures: [], suggestions: [], stopReason: null, oneOff };}
  return null;
}

/**
 * Re-derive entry state via runPrefix when none is persisted (or at RESOLVE/PROVISION).
 */
async function rederiveState(pi: ExtensionAPI, ctx: LoopCtx, change: string): Promise<InitState> {
  const r = await runPrefix(pi, ctx, change);
  if (r.kind === "merged") {return "completed";}
  if (r.kind === "dryRun" || r.kind === "abort") {return "aborted";}
  const s = seedFromPrefix(r, rt.runCtx?.oneOff ?? false);
  if (s) {writeLoopState(ctx.cwd, change, s);}
  return s ? { s } : "aborted";
}

/** Read persisted state; normalize stopped re-entry points before driving. */
async function resolveInitialState(pi: ExtensionAPI, ctx: LoopCtx, change: string): Promise<InitState> {
  const s = readLoopState(ctx.cwd, change);
  if (s && s.phase !== PHASE.RESOLVE && s.phase !== PHASE.PROVISION) {
    if (normalizeResumeState(s)) {writeLoopState(ctx.cwd, change, s);}
    return { s };
  }
  return rederiveState(pi, ctx, change);
}

/** Drive one change from its persisted state to suspension or completion. */
export async function driveChange(pi: ExtensionAPI, ctx: LoopCtx, change: string): Promise<"completed" | "suspended" | "stopped" | "aborted"> {
  const init = await resolveInitialState(pi, ctx, change);
  if (init === "completed" || init === "aborted") {return init;}
  const s = init.s;
  const repoRoot = ctx.cwd;
  const wtDir = join(repoRoot, WORKTREE_ROOT, change);
  const persist = () => writeLoopState(repoRoot, change, s);
  const step: StepCtx = { pi, ctx, change, s, wtDir, persist };
  while (true) {
    if (rt.stopRequested) { s.stopReason = "stopped"; writeLoopState(repoRoot, change, s); return "stopped"; }
    const out = await oneStep(step);
    if (out === "suspend") {return "suspended";}
    if (out === "done") {return "completed";}
    if (out === "stop") {return "stopped";}
    await yieldTick();
  }
}

/** Re-entrant entry (the handler, the review_wait timer, and /loop fetch all
 *  call it). Walks steps until the current change suspends or finishes; for
 *  --all, chains the next TODO change. Owns loopActive + ticker lifecycle. */
function handleCompleted(ctx: LoopCtx): "chain" | "done" {
  const change = rt.runCtx?.change ?? "";
  clearLoopState(ctx.cwd, change);
  ctx.ui.notify(`dev-loop: "${change}" merged ✅`, "info");
  if (rt.runCtx?.all && !rt.runCtx.oneOff) {
    const next = pickTask(ctx.cwd);
    if (next) { rt.runCtx = { ...rt.runCtx, change: next.text }; return "chain"; }
  }
  rt.loopActive = false; stopSentinelTicker(); rt.runCtx = null; releaseLoopLock();
  return "done";
}

/**
 * Tear down a loop chain: record interruptedChange if stopped, clear loopActive/ticker/runCtx.
 */
function endChain(change: string, stopped: boolean): void {
  if (stopped) {rt.interruptedChange = change;}
  rt.loopActive = false; stopSentinelTicker(); rt.runCtx = null; releaseLoopLock();
}

/**
 * Re-entrant driver entry: walk steps until the change suspends/completes; chains --all.
 */
export async function runLoopChain(): Promise<void> {
  if (!rt.piRef || !rt.runCtx || rt.stepping) {return;}
  const pi = rt.piRef;
  const ctx = rt.runCtx.ctx;
  rt.stepping = true;
  try {
    while (rt.runCtx) {
      if (rt.stopRequested) {
        const ch = rt.runCtx.change;
        const s = readLoopState(ctx.cwd, ch);
        if (s) { s.stopReason = "stopped"; writeLoopState(ctx.cwd, ch, s); }
        ctx.ui.notify(`dev-loop: stopped (PR + worktree left); use /loop resume`, "info");
        endChain(ch, true);
        return;
      }
      const outcome = await driveChange(pi, ctx, rt.runCtx.change);
      if (outcome === "suspended") {return;}
      if (outcome === "completed") {
        if (handleCompleted(ctx) === "chain") {continue;}
        return;
      }
      endChain(rt.runCtx.change, outcome === "stopped");
      return;
    }
  } finally {
    rt.stepping = false;
  }
}
