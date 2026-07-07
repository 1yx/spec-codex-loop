# spec-codex-loop

A [pi](https://pi.dev) extension that runs an **autonomous spec-driven PR loop** on `TODO.md`, gated by OpenAI Codex review.

You stay inside pi the whole time. Type `/loop` and it pulls the next TODO task, builds it spec-first with OpenSpec, opens a PR, drives Codex review to a pass, merges, marks the task done, and moves on.

## Flow

```
TODO.md `- [ ]`  →  OpenSpec change  →  implement + test + commit
                 →  push + gh pr create
                 →  @codex review  →  fix per suggestions  →  push  (repeat until pass)
                 →  gh pr merge --squash  →  mark `- [x]`  →  next task
```

The **outer loop is deterministic TypeScript** (it cannot drift across multiple PRs). The fuzzy work — writing the spec, implementing, addressing review — is delegated to **pi's own agent loop**, one bounded turn at a time.

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
/loop                  Run the next TODO task end-to-end, then stop
/loop --dry-run        Build phase only; skip push / PR / review / merge (safe first run)
/loop --all            Keep pulling tasks until TODO.md has none left
/loop --max-rounds 8   Override Codex round cap (default 5)
/loop --yes            Skip the pre-merge confirmation
/loop "one-off task"   Run a task not from TODO.md
```

### `TODO.md` format

Plain checkbox list at the repo root:

```markdown
- [ ] support multi-account cookie import
- [ ] fix macOS login chain
```

On merge, the matched line flips to `- [x]`. If no `TODO.md` (or no unchecked line) exists, the command exits with a notice.

## Preconditions

- `git`, `gh` (authenticated), and `openspec` on `PATH`
- Repo root has an `openspec/` directory (run `openspec init` if not)
- Default branch is `main`; `origin` points at your repo

## Behavior & guardrails

- **Stops, never blind-merges:** on Codex timeout (15 min), no agent progress in a round, or hitting `--max-rounds`, the PR is left open for a human.
- **Merge confirmation** by default (interactive); `--yes` to auto-confirm.
- **First push** uses `git push -u origin <branch>`; subsequent rounds use `git push`.
- While `/loop` runs, don't type into pi manually — a stray message resolves the internal per-turn wait early. `Esc` aborts.

## Architecture

- `pickTask` / `markDone` — `TODO.md` checkbox parse + flip (`node:fs`).
- `driveAgent` — sends a user message and resolves on the next `agent_end`; one shared listener, no accumulation.
- `pollCodex` — polls `gh api` every 60 s (≤15 min) for the bot's response to the current `@codex review` trigger.
- `parseSuggestion` — strips `<sub>` / badge / bold markup → `{ severity, title, body, path, line }`.
- `buildPhase` / `fixPhase` — the two agent-driven prompt types (spec+implement, and address-review).
- `runTask` — the per-task pipeline; `/loop` iterates it.

## Not included (add when needed)

- A separate skill file for per-step prompts (currently constants in `dev-loop.ts`).
- The 👍-reaction pass path (the "Didn't find any major issues" comment covers the observed case).
- Severity-based filtering (all suggestions are addressed; ignore P3 if you want).
- Strict per-artifact OpenSpec gating (proposal / specs / design / tasks) — the agent currently decides artifact depth.
- A `package.json` `pi` manifest for `pi install git:…` distribution.

## License

MIT
