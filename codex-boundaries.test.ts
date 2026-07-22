import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { latestCommentAt, readCodexVerdict, reviewTriggerAt } from "./src/codex.ts";

type ApiReply = { code?: number; value?: unknown; stdout?: string };

class GithubApi {
  readonly calls: string[] = [];
  readonly replies = new Map<string, ApiReply>();
  readonly pi: ExtensionAPI;

  constructor() {
    this.pi = {
      exec: (_command: string, args: string[]) => {
        const endpoint = args[1] ?? "";
        this.calls.push(endpoint);
        const reply = this.replies.get(endpoint) ?? { value: [] };
        return Promise.resolve({
          code: reply.code ?? 0,
          stdout: reply.stdout ?? JSON.stringify(reply.value),
          stderr: reply.code ? "api failure" : "",
        });
      },
    } as unknown as ExtensionAPI;
  }

  page(endpoint: string, value: unknown): void {this.replies.set(endpoint, { value });}
}

const REPO = "owner/repo";
const PR_NUM = 42;
const HEAD = "aaaaaaa111111111111111111111111111111111";
const bot = { login: "chatgpt-codex-connector[bot]" };
const issueUrl = (page = 1) => `repos/${REPO}/issues/${PR_NUM}/comments?per_page=100${page === 1 ? "" : `&page=${page}`}`;
const reviewsUrl = (page = 1) => `repos/${REPO}/pulls/${PR_NUM}/reviews?per_page=100${page === 1 ? "" : `&page=${page}`}`;
const inlineUrl = (page = 1) => `repos/${REPO}/pulls/${PR_NUM}/comments?per_page=100${page === 1 ? "" : `&page=${page}`}`;
const reactionsUrl = (page = 1) => `repos/${REPO}/issues/${PR_NUM}/reactions?per_page=100${page === 1 ? "" : `&page=${page}`}`;
const verdict = (api: GithubApi, triggerAt: string | null = "2026-07-22T00:00:00Z") =>
  readCodexVerdict(api.pi, { repo: REPO, prNum: PR_NUM, head: HEAD, triggerAt });

async function apiFailuresRemainPending(): Promise<void> {
  for (const reply of [{ code: 1 }, { stdout: "{" }]) {
    const api = new GithubApi();
    api.replies.set(issueUrl(), reply);
    assert.equal(await verdict(api), null);
  }
}

async function oldHeadSignalsAreIsolated(): Promise<void> {
  const api = new GithubApi();
  api.page(issueUrl(), [{ id: 1, user: bot, created_at: "2026-07-22T00:01:00Z", body: "Didn't find any major issues. Reviewed commit: bbbbbbb" }]);
  api.page(reviewsUrl(), [{ id: 7, user: bot, state: "COMMENTED", submitted_at: "2026-07-22T00:01:00Z", commit_id: "bbbbbbb222" }]);
  assert.equal(await verdict(api), null);
}

async function reactionPassesCurrentTrigger(): Promise<void> {
  const api = new GithubApi();
  api.page(reactionsUrl(), [{ user: bot, content: "+1", created_at: "2026-07-22T00:01:00Z" }]);
  assert.equal((await verdict(api))?.pass, true);
}

async function passWinsOverFailForSameHead(): Promise<void> {
  const api = new GithubApi();
  api.page(issueUrl(), [{ id: 1, user: bot, created_at: "2026-07-22T00:02:00Z", body: `Didn't find any major issues. Reviewed commit: ${HEAD.slice(0, 7)}` }]);
  api.page(reviewsUrl(), [{ id: 7, user: bot, state: "COMMENTED", submitted_at: "2026-07-22T00:01:00Z", commit_id: HEAD }]);
  api.page(inlineUrl(), [{ id: 8, pull_request_review_id: 7, user: bot, created_at: "2026-07-22T00:01:00Z", body: "**Issue**\nbody", path: "src/a.ts", line: 1 }]);
  assert.equal((await verdict(api))?.pass, true);
}

async function commentsPaginate(): Promise<void> {
  const api = new GithubApi();
  api.page(issueUrl(), Array.from({ length: 100 }, (_, id) => ({ id, user: { login: "someone" }, created_at: "2026-07-22T00:00:00Z", body: "noise" })));
  api.page(issueUrl(2), [{ id: 101, user: bot, created_at: "2026-07-22T00:02:00Z", body: `Didn't find any major issues. Reviewed commit: ${HEAD.slice(0, 7)}` }]);
  assert.equal((await verdict(api))?.pass, true);
  assert.ok(api.calls.includes(issueUrl(2)));
}

async function reviewsAndInlinePaginate(): Promise<void> {
  const api = new GithubApi();
  const decoyReviews = Array.from({ length: 100 }, (_, id) => ({ id, user: { login: "someone" }, state: "COMMENTED", submitted_at: "2026-07-22T00:00:00Z", commit_id: HEAD }));
  const decoyInline = Array.from({ length: 100 }, (_, id) => ({ id, pull_request_review_id: id, user: { login: "someone" }, created_at: "2026-07-22T00:00:00Z", body: "noise" }));
  api.page(reviewsUrl(), decoyReviews);
  api.page(reviewsUrl(2), [{ id: 700, user: bot, state: "COMMENTED", submitted_at: "2026-07-22T00:01:00Z", commit_id: HEAD }]);
  api.page(inlineUrl(), decoyInline);
  api.page(inlineUrl(2), [{ id: 800, pull_request_review_id: 700, user: bot, created_at: "2026-07-22T00:01:00Z", body: "**P1 issue**\nbody", path: "src/a.ts", line: 9 }]);
  const result = await verdict(api, null);
  assert.equal(result?.suggestions[0]?.title, "P1 issue");
  assert.ok(api.calls.includes(reviewsUrl(2)) && api.calls.includes(inlineUrl(2)));
}

async function staleQuotaAndFreshErrorClassifyCorrectly(): Promise<void> {
  const api = new GithubApi();
  api.page(issueUrl(), [
    { id: 1, user: bot, created_at: "2026-07-21T23:59:00Z", body: "Code review usage limits reached" },
    { id: 2, user: bot, created_at: "2026-07-22T00:01:00Z", body: "Something went wrong" },
  ]);
  const result = await verdict(api);
  assert.equal(result?.quotaExhausted, false);
  assert.equal(result?.unclassified, true);
}

async function triggerMarkerSurvivesEventualConsistency(): Promise<void> {
  const api = new GithubApi();
  const nonce = "attempt-1";
  const marker = `@codex review\n<!-- spec-codex-loop:${HEAD}:${nonce} -->`;
  api.page(issueUrl(), [{ id: 1, user: { login: "test-user" }, created_at: "2026-07-22T00:01:00Z", body: marker }]);
  assert.equal(await reviewTriggerAt(api.pi, { repo: REPO, prNum: PR_NUM, head: HEAD, nonce }), "2026-07-22T00:01:00Z");
  assert.equal(await reviewTriggerAt(api.pi, { repo: REPO, prNum: PR_NUM, head: HEAD, nonce: "attempt-2" }), "");
  assert.equal(await latestCommentAt(api.pi, REPO, PR_NUM), "2026-07-22T00:01:00Z");
}

await apiFailuresRemainPending();
await oldHeadSignalsAreIsolated();
await reactionPassesCurrentTrigger();
await passWinsOverFailForSameHead();
await commentsPaginate();
await reviewsAndInlinePaginate();
await staleQuotaAndFreshErrorClassifyCorrectly();
await triggerMarkerSurvivesEventualConsistency();
console.log("ALL 8 CODEX/GITHUB BOUNDARY GROUPS PASSED");
