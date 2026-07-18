import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PollResult, Suggestion } from "./runtime.ts";
import { ghJson } from "./git-utils.ts";

const CODEX_LOGIN = "chatgpt-codex-connector"; // bot login prefix; API may append "[bot]"
const PASS_RE = /Didn't find any major issues/i;
// Quota-exhausted: posted instead of a review when the account's code-review
// budget is spent (resets on its own, usually within a day). Verified phrasings:
//   "You have reached your Codex usage limits for code reviews."
//   "Code review usage limits reached"
const QUOTA_RE = /usage limits? for code reviews|code review usage limits? reached/i;

type GhComment = {
  id: number;
  user?: { login: string };
  created_at: string;
  body: string;
}
type GhReview = {
  id?: number;
  user?: { login: string };
  state: string;
  submitted_at: string;
  commit_id?: string;
  body?: string;
}
type GhInlineComment = {
  pull_request_review_id?: number;
  path?: string;
  line?: number | null;
  commit_id?: string;
} & GhComment

export function isCodex(login?: string): boolean {
  return !!login && login.startsWith(CODEX_LOGIN);
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

function parseSuggestion(c: GhInlineComment): Suggestion {
  const sev = /!\[(P\d)\s+Badge/i.exec(c.body)?.[1] ?? null;
  const cleaned = c.body
    .replace(/<\/?(sub|details|summary)>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\*\*/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const [titleLine, ...rest] = cleaned.split("\n");
  return {
    severity: sev,
    title: titleLine.trim(),
    body: rest.join("\n").trim(),
    path: c.path ?? null,
    line: c.line ?? null,
  };
}

export function formatSuggestions(suggestions: Suggestion[]): string {
  return suggestions
    .map((s, i) => {
      const loc = s.path ? `${s.path}${s.line ? `:${s.line}` : ""}` : "(general)";
      const tag = s.severity ? `[${s.severity}]` : "[n/a]";
      return `${i + 1}. ${tag} ${loc} — ${s.title}\n${s.body}`;
    })
    .join("\n\n");
}

/** Stable key for a round's suggestion set — equal keys mean the same review came back. */
export function suggestionKey(suggestions: Suggestion[]): string {
  return suggestions
    .map((s) => `${s.path ?? ""}:${s.line ?? 0}|${s.title}`)
    .sort()
    .join("\n");
}

/** SHA of the commit a Codex pass comment reviewed, parsed from its body
 *  (`**Reviewed commit:** \`<sha>\``). null if absent. */
function passCommit(body: string): string | null {
  return /Reviewed commit:\D{0,5}([0-9a-f]{7,40})/i.exec(body)?.[1] ?? null;
}

/** created_at of the newest issue comment on the PR — used to timestamp a
 *  just-posted `@codex review` trigger so quota detection can be gated on
 *  freshness (GitHub's clock, not local). */
export async function latestCommentAt(pi: ExtensionAPI, repo: string, prNum: number): Promise<string> {
  const comments =
    (await ghJson<GhComment[]>(pi, `repos/${repo}/issues/${prNum}/comments?per_page=100`)) ?? [];
  return comments[comments.length - 1]?.created_at ?? "";
}

/** Codex's verdict for `head`, or null if Codex hasn't reviewed this commit.
 *  Verdicts are keyed on the commit SHA, not wall-clock, so a stop/resume can't
 *  hide a verdict Codex already gave. Pass takes precedence over a later fail
 *  review for the same commit (Codex is nondeterministic; re-reviewing an
 *  already-passed commit is noise). Quota and bot-error are gated on triggerAt. */
export async function readCodexVerdict(
  pi: ExtensionAPI,
  v: { repo: string; prNum: number; head: string; triggerAt: string | null }
): Promise<PollResult | null> {
  const { repo, prNum, head, triggerAt } = v;
  const head7 = shortSha(head);
  const issueComments =
    (await ghJson<GhComment[]>(pi, `repos/${repo}/issues/${prNum}/comments?per_page=100`)) ?? [];
  const codexIssue = issueComments.filter((c) => isCodex(c.user?.login));

  if (codexIssue.some((c) => PASS_RE.test(c.body) && shortSha(passCommit(c.body) ?? "") === head7)) {
    return { pass: true, timeout: false, stopped: false, quotaExhausted: false, unclassified: false, suggestions: [] };
  }
  if (triggerAt && codexIssue.some((c) => QUOTA_RE.test(c.body) && c.created_at > triggerAt)) {
    return { pass: false, timeout: false, stopped: false, quotaExhausted: true, unclassified: false, suggestions: [] };
  }

  const reviews =
    (await ghJson<GhReview[]>(pi, `repos/${repo}/pulls/${prNum}/reviews?per_page=100`)) ?? [];
  const headReviewIds = new Set(
    reviews
      .filter((r) => isCodex(r.user?.login) && shortSha(r.commit_id ?? "") === head7 && r.id != null)
      .map((r) => r.id as number)
  );
  if (headReviewIds.size > 0) {
    const inline =
      (await ghJson<GhInlineComment[]>(pi, `repos/${repo}/pulls/${prNum}/comments?per_page=100`)) ?? [];
    const suggestions = inline
      .filter(
        (c) =>
          isCodex(c.user?.login) &&
          c.pull_request_review_id != null &&
          headReviewIds.has(c.pull_request_review_id)
      )
      .map(parseSuggestion)
      .filter((s) => s.title);
    return { pass: false, timeout: false, stopped: false, quotaExhausted: false, unclassified: false, suggestions };
  }
  // Codex posted after our trigger but matched nothing above → an unrecognized
  // reply (e.g. a bot "Something went wrong" that does NOT auto-retry). Don't
  // wait out the timeout: return unclassified so the caller stops + clears
  // triggerAt, and /loop resume re-posts @codex review.
  if (triggerAt && codexIssue.some((c) => c.created_at > triggerAt)) {
    return { pass: false, timeout: false, stopped: false, quotaExhausted: false, unclassified: true, suggestions: [] };
  }
  return null;
}
