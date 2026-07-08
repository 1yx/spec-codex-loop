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
| **Pass** | PR comment, body contains `Didn't find any major issues` | `gh api repos/:o/:r/issues/N/comments` | Done → merge |
| **Fail** | review (`state: COMMENTED`) + inline comments | `gh api repos/:o/:r/pulls/N/comments` | Each inline comment fed to the agent as a fix task |
| Pass (edge) | 👍 reaction on the trigger comment | reactions endpoint | Fallback (not observed in the reference PR) |

Each inline comment is `![P1/P2/P3 Badge] … **<title>** <detail>`, with `path` / `line`. The extension parses severity + title + body + location and hands a formatted list to the agent. Inline comments are bound to a commit, so only the latest round's comments are used (stale ones are ignored).

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
/loop <change>         Run one specific change (not from TODO.md)
/loop --dry-run        Build phase only; skip push / PR / review / archive / merge
/loop --all            Keep pulling changes until TODO.md has none left
/loop --max-rounds 8   Optional circuit breaker on review rounds (default: unbounded)
/loop --yes            Skip the pre-merge confirmation
```

### First-time setup (per project)

Run `/loop init` once in a new project. It creates `TODO.md`, adds `TODO.md` + `.worktree/` to `.git/info/exclude` (kept out of git locally, not committed), and runs `openspec init --tools pi`. Idempotent — safe to re-run.

### `TODO.md` format

One OpenSpec **change name** per checkbox line at the repo root (the filename `TODO.md` is matched case-insensitively):

```markdown
- [ ] add-user-auth
- [ ] fix-macos-login-chain
```

Each change must already exist under `openspec/changes/`. On merge, the matched line flips to `- [x]`.

## Preconditions

- `git`, `gh` (authenticated), and `openspec` on `PATH`
- Repo root has an `openspec/` directory — run `/loop init` to scaffold it (plus `TODO.md` + local gitignore) in a new project
- Each TODO change exists under `openspec/changes/` in this repo (committed or not — if it isn't on `origin/main` yet, it is copied into the worktree and committed there)
- Default branch is `main`; `origin` points at your repo

## Behavior & guardrails

- **Worktree per change.** Each change gets `git worktree add .worktree/<change> -b <change> origin/main`; branch and worktree name equal the change name (no `feat/` prefix). All agent work is scoped to that worktree (the prompt gives the absolute path; a HEAD-advance check aborts if the agent commits outside it).
- **Archive before merge.** Once Codex passes, `openspec archive <change>` folds the specs into `openspec/specs/` and moves the change to `archive/`, committed to the PR branch, then merged.
- **Cleanup on success.** After `gh pr merge --squash --delete-branch`, the worktree is removed and its branch deleted. On any failure the PR **and** worktree are left for inspection.
- **Keeps fixing until Codex passes.** Rounds are unbounded by default — it stays in the review→fix loop until Codex passes, **or** a stop fires: no Codex review after the wait (10 min), no agent progress in a round, a **repeating review** (same issues reappearing ⇒ fixes flip-flopping), or an explicit `--max-rounds N` cap.
- **Merge confirmation** by default (interactive); `--yes` to auto-confirm.
- While `/loop` runs, don't type into pi manually — a stray message resolves the internal per-turn wait early. `Esc` aborts.

## Architecture

- `findTodoFile` / `pickTask` / `markDone` — case-insensitive `TODO.md` checkbox parse + flip (`node:fs`).
- `ensureLocalIgnore` / `removeWorktree` — `.git/info/exclude` + worktree/branch teardown helpers.
- `driveAgent` — sends a user message and resolves on the next `agent_end`; one shared listener, no accumulation.
- `awaitCodexReview` — polls the bot's response to the current `@codex review` trigger every 10 min, retrying on empty up to 30 min.
- `parseSuggestion` — strips `<sub>` / badge / bold markup → `{ severity, title, body, path, line }`.
- `buildPhase` / `fixPhase` — agent-driven prompts scoped to the change's worktree (follow the `openspec-apply-change` skill; and address-review).
- `runTask` — the per-change worktree pipeline (worktree → build → review loop → archive → merge → teardown); `/loop` iterates it.

## Not included (add when needed)

- A separate skill file for per-step prompts (currently constants in `dev-loop.ts`).
- The 👍-reaction pass path (the "Didn't find any major issues" comment covers the observed case).
- Severity-based filtering (all suggestions are addressed; ignore P3 if you want).
- Strict per-artifact OpenSpec gating (proposal / specs / design / tasks) — the agent currently decides artifact depth.
- A `package.json` `pi` manifest for `pi install git:…` distribution.

## License

MIT
