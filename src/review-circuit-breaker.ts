import { dirname } from "node:path";
import { REVIEW_FAILURE_LIMIT, type ReviewHistoryEntry, type Suggestion } from "./runtime.ts";

export const STRATEGY_STOP_REASONS = new Set(["strategy_required", "review_round_limit"]);

/** Stop decision returned before a failed verdict enters FIX. */
export type CircuitDecision = {
  stopReason: "strategy_required" | "review_round_limit" | null;
  summary: string | null;
}

/** True when a stop requires explicit strategy acknowledgement. */
export function isStrategyStopReason(reason: string | null): boolean {
  return reason !== null && STRATEGY_STOP_REASONS.has(reason);
}

/** Convert a full verdict into its compact persisted history representation. */
export function reviewHistoryEntry(
  s: { strategyEpoch: number; round: number; head: string },
  suggestions: Suggestion[],
): ReviewHistoryEntry {
  return {
    epoch: s.strategyEpoch,
    round: s.round,
    head: s.head,
    findings: suggestions.map(({ severity, title, path, line }) => ({ severity, title, path, line })),
    fixHead: null,
  };
}

/** Deterministic review-churn detector. The hard limit is evaluated per strategy epoch. */
export function evaluateReviewCircuit(history: ReviewHistoryEntry[], epoch: number): CircuitDecision {
  const entries = history.filter((entry) => entry.epoch === epoch);
  if (entries.length >= REVIEW_FAILURE_LIMIT) {
    return {
      stopReason: "review_round_limit",
      summary: `${entries.length} failed Codex reviews reached the per-strategy limit of ${REVIEW_FAILURE_LIMIT}`,
    };
  }
  if (entries.length < 3) {return { stopReason: null, summary: null };}

  const recent = entries.slice(-3);
  const signals: string[] = [];
  let score = 0;
  const sharedScope = commonScope(recent);
  if (sharedScope) {score += 3; signals.push(`same area: ${sharedScope}`);}
  const counts = recent.map((entry) => entry.findings.length);
  if (counts[1] >= counts[0] && counts[2] >= counts[1]) {
    score += 2; signals.push(`finding count did not decline (${counts.join(" -> ")})`);
  }
  if (hasPathOverlap(recent[1], recent[2])) {
    score += 1; signals.push("latest verdict overlaps the prior verdict's files");
  }
  const priorSeverity = maxSeverity(recent[1]);
  const latestSeverity = maxSeverity(recent[2]);
  if (priorSeverity > 0 && latestSeverity > priorSeverity) {
    score += 3;
    signals.push(`severity escalated (${severityLabel(priorSeverity)} -> ${severityLabel(latestSeverity)})`);
  }
  if (score < 5) {return { stopReason: null, summary: null };}
  return {
    stopReason: "strategy_required",
    summary: `review churn score ${score}: ${signals.join("; ")}`,
  };
}

/** Build exact-file and specific-subdirectory scopes for one verdict. */
function findingScopes(entry: ReviewHistoryEntry): Set<string> {
  const scopes = new Set<string>();
  for (const finding of entry.findings) {
    if (!finding.path) {continue;}
    scopes.add(finding.path);
    let dir = dirname(finding.path);
    // Include every concrete ancestor, but exclude broad top-level buckets such as src/.
    while (dir.includes("/")) {
      scopes.add(`${dir}/`);
      dir = dirname(dir);
    }
  }
  return scopes;
}

/** Most specific file/subdirectory shared by all supplied verdicts. */
function commonScope(entries: ReviewHistoryEntry[]): string | null {
  const [first, ...rest] = entries.map(findingScopes);
  const shared = [...first].filter((scope) => rest.every((scopes) => scopes.has(scope)));
  return shared.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Whether consecutive verdicts contain at least one identical file path. */
function hasPathOverlap(a: ReviewHistoryEntry, b: ReviewHistoryEntry): boolean {
  const paths = new Set(a.findings.map((finding) => finding.path).filter(Boolean));
  return b.findings.some((finding) => finding.path !== null && paths.has(finding.path));
}

/** Convert P0..P3 into an increasing severity rank. */
function severityRank(value: string | null): number {
  const match = /^P([0-3])$/i.exec(value ?? "");
  return match ? 4 - Number(match[1]) : 0;
}

/** Highest classified severity in one verdict. */
function maxSeverity(entry: ReviewHistoryEntry): number {
  return Math.max(0, ...entry.findings.map((finding) => severityRank(finding.severity)));
}

/** Render a severity rank for an explainable stop summary. */
function severityLabel(rank: number): string {
  return rank > 0 ? `P${4 - rank}` : "unclassified";
}
