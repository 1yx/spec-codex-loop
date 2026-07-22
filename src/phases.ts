import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { POLL_TICK_MS, rt, type AgentTurnResult, type LoopCtx, type LoopState, type PhaseCtx } from "./runtime.ts";
import { run } from "./git-utils.ts";
import { formatSuggestions } from "./codex.ts";

/** Send a user message and resolve once the agent is fully settled (including
 *  Pi's automatic retries). Also resolves early if /loop stop fires mid-turn — the
 *  in-flight agent turn runs to its own end, but the loop exits at the next
 *  boundary instead of awaiting it. */
function driveAgent(pi: ExtensionAPI, prompt: string): Promise<AgentTurnResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: AgentTurnResult) => {
      if (done) {return;}
      done = true;
      clearInterval(timer);
      rt.turnResolve = null;
      rt.turnResult = null;
      resolve(result);
    };
    rt.turnResolve = finish;
    rt.turnResult = null;
    const timer = setInterval(() => {
      if (rt.stopRequested) {finish({ ok: false, error: "stopped" });}
    }, POLL_TICK_MS);
    try {
      pi.sendUserMessage(prompt);
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Build step 1 (agent turn): implement the OpenSpec change + tests green + commit.
 *  No push / PR here — those are separate persisted oneStep transitions, so a crash
 *  after this step won't re-run the creative implement work. */
export async function buildImplement(p: PhaseCtx): Promise<AgentTurnResult> {
  const { pi, ctx, change, wtDir } = p;
  const prompt = [
    `Implement the OpenSpec change "${change}" by following the openspec-apply-change skill.`,
    "",
    `ALL work happens inside this git worktree. Use absolute paths under it, and prefix`,
    `every shell command with \`cd ${wtDir} &&\` (the shell does not stay in any directory):`,
    `  ${wtDir}`,
    "",
    "In that worktree, follow the skill flow:",
    `  openspec status --change "${change}" --json`,
    `  openspec instructions apply --change "${change}" --json`,
    "Read the contextFiles it lists, then implement every pending task in tasks.md,",
    "flipping each `- [ ]` to `- [x]` as you complete it. Run the project's tests and fix",
    "until green. If you hit a real blocker, stop and report — do not guess.",
    "",
    "Then commit with a clear conventional message and stop. (Push and PR are handled separately.)",
  ].join("\n");
  ctx.ui.notify(`dev-loop: building ${change} (driving agent in worktree…)`, "info");
  return driveAgent(pi, prompt);
}

/** Review→fix agent turn. Reads prNum/round/suggestions from the persisted state. */
export async function fixPhase(p: PhaseCtx, s: LoopState): Promise<AgentTurnResult> {
  const { pi, ctx, change, wtDir } = p;
  const prior = s.reviewHistory
    .filter((entry) => entry.epoch === s.strategyEpoch && entry.round < s.round)
    .slice(-2)
    .map((entry) => `- Round ${entry.round}: ${entry.findings.map((finding) => `${finding.severity ?? "n/a"} ${finding.path ?? "general"}: ${finding.title}`).join("; ")}`);
  const prompt = [
    `Codex review (round ${s.round}) on PR #${s.prNum} for change "${change}" raised the comments below.`,
    `Address each one. Work inside the worktree (absolute paths under it; prefix shell`,
    `commands with \`cd ${wtDir} &&\`), run tests, then commit. Do NOT push.`,
    ...(prior.length > 0 ? ["", "Recent review history (avoid fixes that recreate adjacent failures):", ...prior] : []),
    "",
    formatSuggestions(s.suggestions),
  ].join("\n");
  ctx.ui.notify(`dev-loop: addressing round ${s.round} review (driving agent…)`, "info");
  return driveAgent(pi, prompt);
}

/** Review inner: origin/main advanced and conflicts with this change. The agent
 *  runs `git merge origin/main` (it conflicts) then resolves using BOTH sides'
 *  context — the change's openspec intent AND what main changed — so it doesn't
 *  sacrifice already-merged main code. If a conflict needs a human judgment call,
 *  the agent leaves it unmerged and stops. */
export async function resolveMainPhase(p: PhaseCtx): Promise<AgentTurnResult> {
  const { pi, ctx, change, wtDir } = p;
  const prompt = [
    `origin/main advanced and conflicts with the "${change}" change in this worktree.`,
    `If a merge is not already in progress, first run \`git merge origin/main\` (it will conflict). Then resolve honoring BOTH sides — don't sacrifice already-merged main code for this change.`,
    "",
    `Work inside the worktree (absolute paths; prefix shell with \`cd ${wtDir} &&\`): ${wtDir}`,
    "",
    "Understand BOTH sides before resolving:",
    "- This change's intent:",
    `    openspec status --change "${change}" --json`,
    `    openspec instructions apply --change "${change}" --json`,
    "    Read the listed contextFiles (design.md / specs) — preserve this change's semantics.",
    "- What origin/main changed (already-merged, legitimate — do NOT revert it to serve this change):",
    "    git log --oneline -15 origin/main",
    "    git diff   # the conflicts; markers show 'ours' (this change) vs 'theirs' (main)",
    "",
    "Resolve each conflict keeping both sides' intent where compatible. Run tests, then commit the merge.",
    "If a conflict genuinely needs a human judgment call — resolving it would discard one side's legitimate",
    "work — do NOT force it: leave that conflict unmerged and stop. The loop stops for manual review.",
    "Do NOT push — the loop pushes after.",
  ].join("\n");
  ctx.ui.notify(`dev-loop: resolving origin/main merge conflicts for ${change} (driving agent…)`, "info");
  return driveAgent(pi, prompt);
}

/** Precondition checks shared by the normal run and /loop resume. */
export async function checkPreconditions(pi: ExtensionAPI, ctx: LoopCtx): Promise<boolean> {
  for (const cmd of ["git", "gh", "openspec"]) {
    const { code } = await run(pi, ["sh", "-c", `command -v ${cmd}`]);
    if (code !== 0) {
      ctx.ui.notify(`dev-loop: required command missing: ${cmd}`, "error");
      return false;
    }
  }
  const { code: osDir } = await run(pi, ["sh", "-c", `test -d openspec`]);
  if (osDir !== 0) {
    ctx.ui.notify("dev-loop: no openspec/ dir — run `/loop init` first", "error");
    return false;
  }
  return true;
}
