import { rt, type StepCtx } from "./runtime.ts";

/** Persist an exhausted agent/provider failure without advancing the current
 * re-entrant state. `/loop resume` will retry that same phase. */
export function stopForAgentFailure(step: StepCtx, error: string | null): "stop" {
  const { ctx, change, s, persist } = step;
  const rateLimited = !!error && /(?:\b429\b|rate.?limit|too many requests)/i.test(error);
  s.stopReason = rateLimited ? "agent_rate_limited" : "agent_error";
  rt.interruptedChange = change;
  ctx.ui.notify(
    rateLimited
      ? `dev-loop: agent LLM retries exhausted after rate limiting; stopped at ${s.phase}${s.inner ? ` / ${s.inner}` : ""} — /loop resume retries this stage`
      : `dev-loop: agent failed${error ? ` (${error})` : ""}; stopped at ${s.phase}${s.inner ? ` / ${s.inner}` : ""} — /loop resume retries this stage`,
    rateLimited ? "warning" : "error",
  );
  persist();
  return "stop";
}
