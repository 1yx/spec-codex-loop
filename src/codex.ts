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

/**
 * GitHub issue/PR comment (the \@codex review trigger + verdict comments).
 */
type GhComment = {
  id: number;
  user?: { login: string };
  created_at: string;
  body: string;
}
/**
 * GitHub PR review object (state + reviewed commit + body).
 */
type GhReview = {
  id?: number;
  user?: { login: string };
  state: string;
  submitted_at: string;
  commit_id?: string;
  body?: string;
}
/**
 * GitHub PR review inline comment (scoped to its review via pull_request_review_id).
 */
type GhInlineComment = {
  pull_request_review_id?: number;
  path?: string;
  line?: number | null;
  commit_id?: string;
} & GhComment

/** Read every page from a GitHub array endpoint. The first-page URL stays
 * compatible with existing gh mocks; later pages are requested only when full. */
async function ghJsonAll<T>(pi: ExtensionAPI, endpoint: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const suffix = page === 1 ? "?per_page=100" : `?per_page=100&page=${page}`;
    const items = await ghJson<T[]>(pi, `${endpoint}${suffix}`);
    if (!items) {return all;}
    all.push(...items);
    if (items.length < 100) {return all;}
  }
}

/**
 * True if the comment/review author is the Codex bot.
 */
export function isCodex(login?: string): boolean {
  return !!login && login.startsWith(CODEX_LOGIN);
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * Parse a Codex inline comment into a Suggestion: strip markup, split title/body, keep location.
 */
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

/**
 * Format a suggestion set as the numbered list fed to the fix-phase agent prompt.
 */
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
 *  ("Reviewed commit: <sha>"). null if absent. */
function passCommit(body: string): string | null {
  return /Reviewed commit:\D{0,5}([0-9a-f]{7,40})/i.exec(body)?.[1] ?? null;
}

/** created_at of the newest issue comment on the PR — used to timestamp a
 *  just-posted `@codex review` trigger so quota detection can be gated on
 *  freshness (GitHub's clock, not local). */
export async function latestCommentAt(pi: ExtensionAPI, repo: string, prNum: number): Promise<string> {
  const comments = await ghJsonAll<GhComment>(pi, `repos/${repo}/issues/${prNum}/comments`);
  return comments[comments.length - 1]?.created_at ?? "";
}

/** Timestamp of this exact trigger attempt. The nonce prevents a historical
 * attempt for the same head from suppressing an intentional re-trigger. */
export async function reviewTriggerAt(pi: ExtensionAPI, ids: { repo: string; prNum: number; head: string; nonce: string }): Promise<string> {
  const marker = `<!-- spec-codex-loop:${ids.head}:${ids.nonce} -->`;
  const comments = await ghJsonAll<GhComment>(pi, `repos/${ids.repo}/issues/${ids.prNum}/comments`);
  return comments.findLast((comment) => comment.body.includes(marker))?.created_at ?? "";
}

/** True if any Codex issue comment is a pass verdict for head7. */
function passCommentForHead(codexIssue: GhComment[], head7: string): boolean {
  return codexIssue.some((c) => PASS_RE.test(c.body) && shortSha(passCommit(c.body) ?? "") === head7);
}

/** True if Codex gave a 👍 reaction on the PR after triggerAt (the "no issues" pass signal
 *  when it doesn't leave a comment). Observed on endurance-race PR #22. */
async function codexThumbsUp(pi: ExtensionAPI, v: { repo: string; prNum: number; triggerAt: string }): Promise<boolean> {
  const reactions =
    await ghJsonAll<{ user?: { login: string }; content: string; created_at: string }>(pi, `repos/${v.repo}/issues/${v.prNum}/reactions`);
  return reactions.some((r) => isCodex(r.user?.login) && r.content === "+1" && r.created_at > v.triggerAt);
}

/** True if a Codex quota-exhausted comment landed after triggerAt. */
function codexQuotaAfter(codexIssue: GhComment[], triggerAt: string): boolean {
  return codexIssue.some((c) => QUOTA_RE.test(c.body) && c.created_at > triggerAt);
}

/** True if Codex posted any issue comment after triggerAt (unclassified reply). */
function codexReplyAfter(codexIssue: GhComment[], triggerAt: string): boolean {
  return codexIssue.some((c) => c.created_at > triggerAt && !PASS_RE.test(c.body));
}

/** Read Codex's inline suggestions for head. null = no Codex review on this
 *  commit; empty array = reviewed with no suggestions (pass); non-empty = fail. */
async function readHeadSuggestions(pi: ExtensionAPI, ids: { repo: string; prNum: number; head7: string }): Promise<Suggestion[] | null> {
  const { repo, prNum, head7 } = ids;
  const reviews = await ghJsonAll<GhReview>(pi, `repos/${repo}/pulls/${prNum}/reviews`);
  const headReviewIds = new Set(
    reviews
      .filter((r): r is GhReview & { id: number } => isCodex(r.user?.login) && shortSha(r.commit_id ?? "") === head7 && r.id != null)
      .map((r) => r.id)
  );
  if (headReviewIds.size === 0) {return null;}
  const inline = await ghJsonAll<GhInlineComment>(pi, `repos/${repo}/pulls/${prNum}/comments`);
  return inline
    .filter((c) => isCodex(c.user?.login) && c.pull_request_review_id != null && headReviewIds.has(c.pull_request_review_id))
    .map(parseSuggestion)
    .filter((s) => s.title);
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
  const issueComments = await ghJsonAll<GhComment>(pi, `repos/${repo}/issues/${prNum}/comments`);
  const codexIssue = issueComments.filter((c) => isCodex(c.user?.login));

  if (passCommentForHead(codexIssue, head7)) {
    return { pass: true, timeout: false, stopped: false, quotaExhausted: false, unclassified: false, suggestions: [] };
  }
  if (triggerAt && (await codexThumbsUp(pi, { repo, prNum, triggerAt }))) {
    return { pass: true, timeout: false, stopped: false, quotaExhausted: false, unclassified: false, suggestions: [] };
  }
  if (triggerAt && codexQuotaAfter(codexIssue, triggerAt)) {
    return { pass: false, timeout: false, stopped: false, quotaExhausted: true, unclassified: false, suggestions: [] };
  }

  const suggestions = await readHeadSuggestions(pi, { repo, prNum, head7 });
  if (suggestions !== null) {
    return { pass: suggestions.length === 0, timeout: false, stopped: false, quotaExhausted: false, unclassified: false, suggestions };
  }
  // Codex posted after our trigger but matched nothing above → an unrecognized
  // reply (e.g. a bot "Something went wrong" that does NOT auto-retry). Don't
  // wait out the timeout: return unclassified so the caller stops + clears
  // triggerAt, and /loop resume re-posts @codex review.
  if (triggerAt && codexReplyAfter(codexIssue, triggerAt)) {
    return { pass: false, timeout: false, stopped: false, quotaExhausted: false, unclassified: true, suggestions: [] };
  }
  return null;
}
