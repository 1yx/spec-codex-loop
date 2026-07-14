# spec-codex-loop

A [pi](https://pi.dev) extension that runs an **autonomous spec-driven PR loop** on `TODO.md`, gated by OpenAI Codex review.

You stay inside pi the whole time. Outside the loop you create an OpenSpec change (e.g. with the explore / grill-me skills) and add its name as a `- [ ] <change>` line in `TODO.md`. Then `/loop` spins up a dedicated git worktree for that change, implements it via the `openspec-apply-change` skill, opens a PR, drives Codex review to a pass, archives the change, merges, and removes the worktree.

## Flow

```
TODO.md `- [ ] <change>`  →  git worktree .worktree/<change> on branch <change>
   →  openspec-apply-change (implement tasks + tests) → commit → push → gh pr create
   →  @codex review  →  fix per suggestions  →  push  (repeat until Codex passes / repeats)
   →  openspec archive  →  gh pr merge --squash  →  mark `- [x]`  →  remove worktree
```

The **outer loop is deterministic TypeScript** (it cannot drift across multiple PRs). The fuzzy work — implementing the change, addressing review — is delegated to **pi's own agent loop**, one bounded turn at a time, each scoped to the change's worktree.

## Codex review signal contract

Codex does **not** expose a reliable review state (`state` is always `COMMENTED`). The pass/fail signal lives in what the bot posts. Verified against a real iteration (multiple review/fix rounds).

Bot login prefix: `chatgpt-codex-connector`.

| Signal | Form | How it's read | Verdict |
|---|---|---|---|
| **Pass** | PR comment, body contains `Didn't find any major issues` + `Reviewed commit: \`<sha>\`` | `gh api repos/:o/:r/issues/N/comments` | Done → merge |
| **Fail** | review (`state: COMMENTED`, `commit_id` = head) + inline comments | `gh api repos/:o/:r/pulls/N/reviews` + `…/pulls/N/comments` | Each inline comment fed to the agent as a fix task |
| **Quota exhausted** | PR comment, body matches `usage limits? for code reviews` / `code review usage limits? reached` (e.g. "You have reached your Codex usage limits for code reviews.") | same comments endpoint | Stop → leave PR + worktree; `/loop resume` after the quota resets |
| Pass (edge) | 👍 reaction on the trigger comment | reactions endpoint | Fallback (not observed in the reference PR) |

Each inline comment is `![P1/P2/P3 Badge] … **<title>** <detail>`, with `path` / `line`. The extension parses severity + title + body + location and hands a formatted list to the agent.

**Verdicts are keyed on the HEAD commit, not on a wall-clock window.** Each round reads the worktree's `HEAD`, then looks for Codex's verdict on *that* commit: a pass comment whose `Reviewed commit:` matches `HEAD` → merge; a review whose `commit_id` matches `HEAD` → fix its inline comments; otherwise trigger `@codex review` and poll. So a stop mid-review or a `/loop resume` reuses a verdict Codex already gave instead of re-triggering and chasing a nondeterministic re-review. A pass takes precedence over a later fail review for the same commit.

Inline comments are scoped to the head review by `pull_request_review_id`. The inline comments' own `commit_id` field is **not** usable for this: on a real PR it carried a third, unrelated SHA (neither the review's commit nor the PR head), so associating by it would select the wrong comments.

Quota detection is gated on the trigger's own timestamp (read from GitHub, not the local clock): only a quota comment posted *after* the current round's `@codex review` counts, so a stale quota from before a resume can't fire and block progress indefinitely.

## Install

Copy into pi's global extensions dir (auto-discovered, hot-reloads with `/reload`):

```bash
mkdir -p ~/.pi/agent/extensions
cp dev-loop.ts ~/.pi/agent/extensions/dev-loop.ts
```

Or load once for testing without installing:

```bash
pi -e ./dev-loop.ts
```

Then `/reload` inside pi (or restart) to pick it up.

## Usage

```
/loop init             First-time setup: create TODO.md, git-ignore TODO.md + .worktree/, openspec init
/loop                  Run the next TODO change end-to-end, then stop
/loop <change>         Run a specific change (added to TODO.md if absent, then run)
/loop --dry-run        Build phase only; skip push / PR / review / archive / merge
/loop --all            Keep pulling changes until TODO.md has none left

/loop stop             Stop the running loop at the next safe boundary (PR + worktree kept)
/loop fetch            Re-fetch the Codex review now instead of waiting ≤10min
/loop resume           Resume the change last stopped via /loop stop
```

`/loop resume` re-enters the loop driver for the change last stopped via `/loop stop`. `/loop stop` and `/loop fetch` work in real time even while a `/loop` is running (see "Control during a run").

### Control during a run

`/loop stop` and `/loop fetch` work in real time while a `/loop` is running. The loop is a **re-entrant state machine**, not a blocking handler: the `/loop` command returns as soon as it reaches `review_wait` (the only long wait), after persisting its phase/inner-state to `.worktree/<change>/.loop-state.json` and scheduling a `setTimeout` to re-probe in 10 min. pi is then back at its prompt, so the next `/loop fetch` or `/loop stop` dispatches immediately and the loop reacts within ~1 s at its next step boundary.

```bash
/loop fetch            # re-check Codex now (skip the ≤10-min wait)
/loop stop             # stop at the next safe boundary (PR + worktree kept)
```

From **another terminal** (a different shell, SSH — anywhere you can't run a pi slash command), the same signals work via sentinel files polled once per second:

```bash
touch .dev-loop-fetch  # same as /loop fetch
touch .dev-loop-stop   # same as /loop stop
```

The loop unlinks each sentinel as it consumes it, and clears stale ones at the start of every run. `Esc` aborts the current agent turn (build/fix) but does **not** reach the `review_wait` timer — use `/loop stop` for a reliable stop.

> **Why this design.** pi serializes command dispatch behind a running command handler. An earlier version held the `/loop` handler open across the 10-min poll (`await sleep`), so every later input — including `/loop fetch` — queued until the loop finished. Splitting review into a persisted state machine that yields the handler at each wait is what makes live control possible.

### First-time setup (per project)

Run `/loop init` once in a new project. It creates `TODO.md`, adds `TODO.md` + `.worktree/` to `.git/info/exclude` (kept out of git locally, not committed), and runs `openspec init --tools pi`. Idempotent — safe to re-run.

### `TODO.md` format

One OpenSpec **change name** per checkbox line at the repo root (the filename `TODO.md` is matched case-insensitively):

```markdown
- [ ] add-user-auth
- [ ] fix-macos-login-chain
```

Each change must already exist under `openspec/changes/`. On merge, the matched line flips to `- [x]`.

### Why a separate `TODO.md` (not `openspec list`)

OpenSpec already knows what's done — `openspec archive` moves a change out of `openspec/changes/`, so `openspec list` could serve as the queue on its own. We keep a separate `TODO.md` anyway, for one reason: **ordering belongs outside the change name.**

- **OpenSpec rejects ordered names.** `validateChangeName` requires names to start with a lowercase letter — `01-add-auth` → `✖ Change name must start with a letter` (verified on OpenSpec 1.2.0). And `openspec list` only sorts by `recent` (last-modified, jittery on every edit) or `name` (alphabetic, no priority). So there's no in-band way to say "do this before that."
- **The community agrees names shouldn't carry ordering.** The numeric-prefix request ([Fission-AI/OpenSpec#850](https://github.com/Fission-AI/OpenSpec/issues/850)) — `100-audit → 200-implement → 300-validate` for tiers, `101-01/02` for parallel batches within a tier — was pushed back on precisely because it "couples naming with execution concerns" and turns the name into "a container for orchestration metadata." The stance: change names are **identifiers**, not sequencing. The only in-band workaround is a letter prefix (`s-001-…`, `p100-…`), which still pollutes the identifier.
- **Markdown carries ordering natively, names can't.** The three-digit scheme exists *only* because an OpenSpec name has nowhere else to encode sequence + grouping. `TODO.md` is a free-form ordered document: sequence is line order, grouping/parallelism is nesting — with the change name left clean.

Net: change name = **what** (stable identifier); `TODO.md` = **in what order** (the sequencing layer). Completion stays a single source of truth in `archive`; the `- [x]` flip is a convenience marker, not the record.

## Preconditions

- `git`, `gh` (authenticated), and `openspec` on `PATH`
- Repo root has an `openspec/` directory — run `/loop init` to scaffold it (plus `TODO.md` + local gitignore) in a new project
- Each TODO change exists under `openspec/changes/` in this repo (committed or not — if it isn't on `origin/main` yet, it is copied into the worktree and committed there)
- If the worktree (created from `origin/main`) has no `openspec/` at all — e.g. `openspec` is git-ignored, or just never committed — the whole `openspec/` dir is copied in from the main repo instead (untracked, so it doesn't pollute the PR)
- Default branch is `main`; `origin` points at your repo

## Behavior & guardrails

- **Worktree per change.** Each change gets `git worktree add .worktree/<change> -b <change> origin/main`; branch and worktree name equal the change name (no `feat/` prefix). All agent work is scoped to that worktree (the prompt gives the absolute path; buildPhase is gated on an open PR appearing, which also catches the agent working outside the worktree).
- **Archive before merge.** Once Codex passes, `openspec archive <change>` folds the specs into `openspec/specs/` and moves the change to `archive/`, committed to the PR branch, then merged. (When `openspec/` came in via the whole-dir copy — untracked — archive output is untracked too; specs stay local, which is the point of keeping `openspec` out of `origin/main`.)
- **Cleanup on success.** After `gh pr merge --squash --delete-branch`, the worktree is removed and its branch deleted. On any failure the PR **and** worktree are left for inspection.
- **Resumable.** Re-running `/loop` (or `/loop <change>`) for an interrupted change picks up where it left off: it detects the existing worktree + PR state (none / open / merged) and the change's archived-ness, then skips completed stages and continues. A merged-but-uncleaned change just gets its worktree torn down and its TODO line marked.
- **Keeps fixing until Codex passes.** Rounds are unbounded — it stays in the review→fix loop until Codex passes, **or** a stop fires: **Codex quota exhausted** (the bot posts "You have reached your Codex usage limits for code reviews." — stop, `/loop resume` after it resets), `/loop stop`, no Codex review after the wait (10 min), no agent progress in a round, or a **repeating review** (same issues reappearing ⇒ fixes flip-flopping).
- **Merges automatically** once Codex passes (no confirmation) — archive → squash-merge → worktree teardown.
- While `/loop` runs, `/loop stop` / `/loop fetch` reach the loop in real time — the handler returns during each `review_wait`, so pi is back at its prompt (see "Control during a run"). Free-text submits are consumed with a reminder. `Esc` aborts the current agent turn (build/fix) but does **not** reach the `review_wait` timer; use `/loop stop` (or `touch .dev-loop-stop`) for a reliable stop.

## Architecture

- `findTodoFile` / `pickTask` / `markDone` — case-insensitive `TODO.md` checkbox parse + flip (`node:fs`).
- `ensureLocalIgnore` / `removeWorktree` / `prStateFor` — local gitignore, worktree/branch teardown, and PR-state (for resume) helpers.
- `driveAgent` — sends a user message and resolves on the next `agent_end`; one shared listener, no accumulation.
- `readCodexVerdict` — reads Codex's verdict for the current HEAD commit (pass comment, fail review + inline comments, or quota); the loop reuses an existing verdict for the head before triggering.
- `parseSuggestion` — strips `<sub>` / badge / bold markup → `{ severity, title, body, path, line }`.
- `buildPhase` / `fixPhase` — agent-driven prompts scoped to the change's worktree (follow the `openspec-apply-change` skill; and address-review).
- `lifecycle-state.ts` — pure outer phase model (`PHASE` + `REVIEW_INNER` + transition graph + `resolvePhase`); no I/O, fully unit-tested.
- `runPrefix` / `oneStep` / `driveChange` / `runLoopChain` — the re-entrant driver. `runPrefix` does resolve→provision→build; `oneStep` runs one transition of the review inner machine (reconcile→probe→trigger→**wait**→fix) or the archive/merge/cleanup suffix; `runLoopChain` is the single re-entry point (the handler, the `review_wait` timer, and `/loop fetch` all call it) that walks steps (setImmediate yield between them), chains `--all`, and owns `loopActive` + the wait-timer + sentinel-ticker lifecycle. State persists to `.worktree/<change>/.loop-state.json`, so any stop / resume / crash re-enters at the exact phase.

## Not included (add when needed)

- A separate skill file for per-step prompts (currently constants in `dev-loop.ts`).
- The 👍-reaction pass path (the "Didn't find any major issues" comment covers the observed case).
- Severity-based filtering (all suggestions are addressed; ignore P3 if you want).
- Strict per-artifact OpenSpec gating (proposal / specs / design / tasks) — the agent currently decides artifact depth.

## License

MIT
