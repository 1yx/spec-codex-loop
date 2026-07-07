/**
 * dev-loop — autonomous spec-driven PR loop on TODO.md, gated by Codex review.
 *
 * Flow per task:
 *   TODO.md `- [ ]`  →  openspec change  →  implement+commit
 *   →  push + gh pr create  →  @codex review  →  fix per suggestions
 *   →  repeat review until Codex passes (or max-rounds)  →  merge --squash  →  mark `- [x]`
 *
 * Usage (inside pi):
 *   /loop                 run the next TODO task end-to-end (one task, then stop)
 *   /loop --dry-run       build phase only; skip push/PR/review/merge (safe first run)
 *   /loop --all           keep pulling tasks from TODO.md until none left
 *   /loop --max-rounds 8  override Codex review round cap (default 5)
 *   /loop --yes           skip the pre-merge confirmation
 *   /loop "task text"     run a one-off task not from TODO.md
 *
 * The OUTER loop is deterministic code (can't drift). The fuzzy work
 * (write spec, implement, address review) is delegated to pi's own agent
 * loop one bounded turn at a time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_LOGIN = "chatgpt-codex-connector"; // bot login prefix; API may append "[bot]"
const PASS_RE = /Didn't find any major issues/i;
const DEFAULT_MAX_ROUNDS = 5;
const POLL_INTERVAL_MS = 60_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

interface Suggestion {
  severity: string | null;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
}
interface PollResult {
  pass: boolean;
  timeout: boolean;
  suggestions: Suggestion[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/** Run a command via pi.exec; returns trimmed stdout + exit code. */
async function run(
  pi: ExtensionAPI,
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await pi.exec(cmd, args);
  return {
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    code: r.code ?? 0,
  };
}

async function ghJson<T>(pi: ExtensionAPI, endpoint: string): Promise<T | null> {
  const { stdout, code } = await run(pi, "gh", ["api", endpoint]);
  if (code !== 0 || !stdout) return null;
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

/** Read TODO.md, return first unchecked `- [ ] task` line (1-indexed) or null. */
function pickTask(cwd: string): { lineNo: number; text: string } | null {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, "TODO.md"), "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*\[\s\]\s+(.+?)\s*$/);
    if (m) return { lineNo: i + 1, text: m[1] };
  }
  return null;
}

/** Flip a specific TODO.md line from `- [ ]` to `- [x]`. */
function markDone(cwd: string, lineNo: number) {
  const file = join(cwd, "TODO.md");
  const lines = readFileSync(file, "utf-8").split("\n");
  if (lineNo >= 1 && lineNo <= lines.length) {
    lines[lineNo - 1] = lines[lineNo - 1].replace(/-\s*\[\s\]/, "- [x]");
    writeFileSync(file, lines.join("\n"));
  }
}

// --- agent drive: one listener, no accumulation --------------------------------
let turnResolve: (() => void) | null = null;

function driveAgent(pi: ExtensionAPI, prompt: string): Promise<void> {
  return new Promise((resolve) => {
    turnResolve = resolve;
    pi.sendUserMessage(prompt);
  });
}

// --- Codex review polling ------------------------------------------------------
interface GhComment {
  id: number;
  user?: { login: string };
  created_at: string;
  body: string;
}
interface GhReview {
  user?: { login: string };
  state: string;
  submitted_at: string;
  commit_id?: string;
  body?: string;
}
interface GhInlineComment extends GhComment {
  path?: string;
  line?: number | null;
  commit_id?: string;
}

function isCodex(login?: string): boolean {
  return !!login && login.startsWith(CODEX_LOGIN);
}

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

function formatSuggestions(suggestions: Suggestion[]): string {
  return suggestions
    .map((s, i) => {
      const loc = s.path ? `${s.path}${s.line ? `:${s.line}` : ""}` : "(general)";
      const tag = s.severity ? `[${s.severity}]` : "[n/a]";
      return `${i + 1}. ${tag} ${loc} — ${s.title}\n${s.body}`;
    })
    .join("\n\n");
}

async function pollCodex(
  pi: ExtensionAPI,
  repo: string,
  prNum: number,
  since: string
): Promise<PollResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const comments = (await ghJson<GhComment[]>(
      pi,
      `repos/${repo}/issues/${prNum}/comments`
    )) ?? [];
    const freshComments = comments.filter((c) => isCodex(c.user?.login) && c.created_at > since);
    if (freshComments.some((c) => PASS_RE.test(c.body))) {
      return { pass: true, timeout: false, suggestions: [] };
    }
    const reviews = (await ghJson<GhReview[]>(
      pi,
      `repos/${repo}/pulls/${prNum}/reviews`
    )) ?? [];
    const failReview = reviews.find(
      (r) => isCodex(r.user?.login) && r.submitted_at > since
    );
    if (failReview) {
      const inline = (await ghJson<GhInlineComment[]>(
        pi,
        `repos/${repo}/pulls/${prNum}/comments`
      )) ?? [];
      const suggestions = inline
        .filter((c) => isCodex(c.user?.login) && c.created_at > since)
        .map(parseSuggestion)
        .filter((s) => s.title);
      return { pass: false, timeout: false, suggestions };
    }
  }
  return { pass: false, timeout: true, suggestions: [] };
}

// --- per-task pipeline ---------------------------------------------------------
async function buildPhase(pi: ExtensionAPI, ctx: any, task: string, slug: string) {
  const prompt = [
    `Task from TODO.md: """${task}"""`,
    "",
    "Do the spec-driven build for this single task:",
    `1. Scaffold an OpenSpec change: run \`openspec new change ${slug} --description "${task.replace(/"/g, "'")}"\`.`,
    `2. Write the change artifacts (proposal, specs, tasks) under openspec/changes/${slug}/ following OpenSpec conventions. Use \`openspec instructions <artifact> --change ${slug}\` to get the prompt for each artifact if useful.`,
    "3. Implement all tasks in tasks.md. Run the project's test command (detect pnpm/npm/uv/pytest). Fix until tests pass.",
    "4. Commit your work with a clear conventional commit message. Do NOT push and do NOT open a PR.",
    "",
    "Work entirely in the current repo. Stop when committed.",
  ].join("\n");
  ctx.ui.notify(`dev-loop: building ${slug} (driving agent…)`, "info");
  await driveAgent(pi, prompt);
}

async function fixPhase(
  pi: ExtensionAPI,
  ctx: any,
  prNum: number,
  round: number,
  suggestions: Suggestion[]
) {
  const prompt = [
    `Codex review (round ${round}) on PR #${prNum} raised the comments below. Address each one in the code, run tests, then commit. Do NOT push.`,
    "",
    formatSuggestions(suggestions),
  ].join("\n");
  ctx.ui.notify(`dev-loop: addressing round ${round} review (driving agent…)`, "info");
  await driveAgent(pi, prompt);
}

async function runTask(
  pi: ExtensionAPI,
  ctx: any,
  task: string,
  opts: { dryRun: boolean; maxRounds: number; yes: boolean }
): Promise<boolean> {
  const cwd = ctx.cwd as string;
  const slug = slugify(task);
  const branch = `feat/${slug}`;

  ctx.ui.notify(`dev-loop: task → ${branch}`, "info");

  // Fresh branch off main.
  await run(pi, "git", ["checkout", "main"]);
  await run(pi, "git", ["pull", "--ff-only"]);
  await run(pi, "git", ["checkout", "-b", branch]);

  await buildPhase(pi, ctx, task, slug);

  // Verify the agent actually produced a commit.
  const { stdout: headBefore } = await run(pi, "git", ["rev-parse", "main"]);
  const { stdout: headAfter } = await run(pi, "git", ["rev-parse", "HEAD"]);
  if (headBefore === headAfter) {
    ctx.ui.notify("dev-loop: agent produced no commit; aborting task", "error");
    await run(pi, "git", ["checkout", "main"]);
    await run(pi, "git", ["branch", "-D", branch]);
    return false;
  }

  if (opts.dryRun) {
    ctx.ui.notify("dev-loop: --dry-run → stopping before push/PR", "info");
    return false;
  }

  // Push + open PR.
  const { code: pushCode, stderr: pushErr } = await run(pi, "git", [
    "push",
    "-u",
    "origin",
    branch,
  ]);
  if (pushCode !== 0) {
    ctx.ui.notify(`dev-loop: git push failed: ${pushErr}`, "error");
    return false;
  }
  const { stdout: repoOut } = await run(pi, "gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const repo = repoOut || "";
  if (!repo) {
    ctx.ui.notify("dev-loop: could not resolve repo via `gh repo view`", "error");
    return false;
  }
  const { stdout: prOut, code: prCode, stderr: prErr } = await run(pi, "gh", [
    "pr",
    "create",
    "--title",
    task,
    "--body",
    `Spec-driven change for TODO task.\n\nOpenSpec change: \`openspec/changes/${slug}\`\n\n@codex review`,
    "--head",
    branch,
    "--repo",
    repo,
  ]);
  if (prCode !== 0) {
    ctx.ui.notify(`dev-loop: gh pr create failed: ${prErr}`, "error");
    return false;
  }
  const prNum = parseInt(prOut.trim().split("/").pop() ?? "0", 10);
  ctx.ui.notify(`dev-loop: PR #${prNum} opened — starting Codex review loop`, "info");

  // Review loop.
  for (let round = 1; round <= opts.maxRounds; round++) {
    const since = new Date().toISOString();
    const { code: trigCode, stderr: trigErr } = await run(pi, "gh", [
      "pr",
      "comment",
      String(prNum),
      "--body",
      "@codex review",
      "--repo",
      repo,
    ]);
    if (trigCode !== 0) {
      ctx.ui.notify(`dev-loop: trigger @codex review failed: ${trigErr}`, "error");
      return false;
    }
    ctx.ui.notify(
      `dev-loop: round ${round}/${opts.maxRounds} — waiting for Codex (≤${POLL_TIMEOUT_MS / 60000}min)…`,
      "info"
    );
    const result = await pollCodex(pi, repo, prNum, since);

    if (result.pass) {
      ctx.ui.notify(`dev-loop: Codex passed on round ${round}`, "info");
      break;
    }
    if (result.timeout) {
      ctx.ui.notify(
        `dev-loop: Codex did not respond in time on round ${round}; stopping (PR left open)`,
        "warning"
      );
      return false;
    }
    if (result.suggestions.length === 0) {
      // Review posted but no actionable inline comments; treat as pass to avoid looping forever.
      ctx.ui.notify(`dev-loop: round ${round} review had no actionable items; treating as pass`, "info");
      break;
    }

    const { stdout: headPre } = await run(pi, "git", ["rev-parse", "HEAD"]);
    await fixPhase(pi, ctx, prNum, round, result.suggestions);
    const { stdout: headPost } = await run(pi, "git", ["rev-parse", "HEAD"]);
    if (headPre === headPost) {
      ctx.ui.notify(
        `dev-loop: agent made no progress on round ${round}; stopping (PR left open)`,
        "warning"
      );
      return false;
    }
    await run(pi, "git", ["push"]);
    if (round === opts.maxRounds) {
      ctx.ui.notify(
        `dev-loop: hit max-rounds (${opts.maxRounds}) without Codex pass; stopping (PR left open)`,
        "warning"
      );
      return false;
    }
  }

  // Merge (with confirmation unless --yes).
  if (!opts.yes && ctx.hasUI) {
    const ok = await ctx.ui.confirm("dev-loop", `Merge PR #${prNum} to main (--squash)?`);
    if (!ok) {
      ctx.ui.notify("dev-loop: merge skipped by user; PR left open", "info");
      return false;
    }
  }
  const { code: mergeCode, stderr: mergeErr } = await run(pi, "gh", [
    "pr",
    "merge",
    String(prNum),
    "--squash",
    "--delete-branch",
    "--repo",
    repo,
  ]);
  if (mergeCode !== 0) {
    ctx.ui.notify(`dev-loop: gh pr merge failed: ${mergeErr}`, "error");
    return false;
  }
  await run(pi, "git", ["checkout", "main"]);
  await run(pi, "git", ["pull", "--ff-only"]);
  ctx.ui.notify(`dev-loop: merged PR #${prNum} to main ✅`, "info");
  return true;
}

// --- project init (/loop init) ------------------------------------------------
async function initProject(pi: ExtensionAPI, ctx: any) {
  const cwd = ctx.cwd as string;

  // 1. TODO.md — the loop's private task backlog.
  const todoPath = join(cwd, "TODO.md");
  if (existsSync(todoPath)) {
    ctx.ui.notify("dev-loop: TODO.md already exists", "info");
  } else {
    writeFileSync(
      todoPath,
      [
        "# TODO",
        "",
        "<!-- spec-codex-loop: add one task per line. Each task line must start",
        "     with: dash, space, open-bracket, space, close-bracket, space, then",
        "     the task text. Example tasks are intentionally not written as literal",
        "     checkbox lines so the loop does not pick them up. -->",
        "",
      ].join("\n")
    );
    ctx.ui.notify("dev-loop: created TODO.md", "info");
  }

  // 2. Keep TODO.md out of git via the local-only exclude (not a committed .gitignore).
  const { stdout: gitDir, code: gitCode } = await run(pi, "git", ["rev-parse", "--git-dir"]);
  if (gitCode !== 0 || !gitDir) {
    ctx.ui.notify("dev-loop: not a git repo; skipped .git/info/exclude", "warning");
  } else {
    const absGitDir = gitDir.startsWith("/") ? gitDir : join(cwd, gitDir);
    const excludePath = join(absGitDir, "info", "exclude");
    try {
      const cur = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
      const already = cur.split("\n").some((l) => l.trim() === "TODO.md");
      if (already) {
        ctx.ui.notify("dev-loop: TODO.md already in .git/info/exclude", "info");
      } else {
        const prefix = cur && !cur.endsWith("\n") ? "\n" : "";
        writeFileSync(excludePath, `${cur}${prefix}\n# spec-codex-loop (local-only)\nTODO.md\n`);
        ctx.ui.notify("dev-loop: added TODO.md to .git/info/exclude", "info");
      }
    } catch (e) {
      ctx.ui.notify(`dev-loop: could not update .git/info/exclude: ${String(e)}`, "warning");
    }
  }

  // 3. OpenSpec scaffolding, non-interactive and pi-targeted.
  if (existsSync(join(cwd, "openspec"))) {
    ctx.ui.notify("dev-loop: openspec/ already present", "info");
  } else {
    const { code, stderr } = await run(pi, "openspec", ["init", "--tools", "pi"]);
    if (code === 0) ctx.ui.notify("dev-loop: ran `openspec init --tools pi`", "info");
    else ctx.ui.notify(`dev-loop: openspec init failed: ${stderr}`, "error");
  }
}

// --- entry point ---------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  pi.on("agent_end", () => {
    const r = turnResolve;
    turnResolve = null;
    r && r();
  });

  pi.registerCommand("loop", {
    description:
      "Autonomous TODO.md → openspec → PR → Codex review → merge loop. Flags: --dry-run --all --max-rounds N --yes",
    handler: async (args, ctx) => {
      const argv = String(args ?? "").trim();
      const tokens = argv.split(/\s+/).filter(Boolean);
      if (tokens[0] === "init") {
        await initProject(pi, ctx);
        return;
      }
      const dryRun = tokens.includes("--dry-run");
      const all = tokens.includes("--all");
      const yes = tokens.includes("--yes");
      const mrIdx = tokens.indexOf("--max-rounds");
      const maxRounds = mrIdx >= 0 ? parseInt(tokens[mrIdx + 1] ?? "", 10) || DEFAULT_MAX_ROUNDS : DEFAULT_MAX_ROUNDS;
      const positional = tokens.filter((t) => !t.startsWith("--") && t !== tokens[mrIdx + 1]);

      const cwd = ctx.cwd as string;

      // Preconditions.
      for (const cmd of ["git", "gh", "openspec"]) {
        const { code } = await run(pi, "sh", ["-c", `command -v ${cmd}`]);
        if (code !== 0) {
          ctx.ui.notify(`dev-loop: required command missing: ${cmd}`, "error");
          return;
        }
      }
      const { code: osDir } = await run(pi, "sh", ["-c", `test -d openspec`]);
      if (osDir !== 0) {
        ctx.ui.notify("dev-loop: no openspec/ dir — run `openspec init` first", "error");
        return;
      }

      const oneOff = positional.join(" ");
      const useTodo = !oneOff;
      if (useTodo) {
        if (!pickTask(cwd)) {
          ctx.ui.notify("dev-loop: no unchecked `- [ ]` task in TODO.md", "warning");
          return;
        }
      }

      // Single task (one-off arg) or iterate TODO until done / --all.
      while (true) {
        let task: { text: string; lineNo: number | null } | null;
        if (oneOff) {
          task = { text: oneOff, lineNo: null };
        } else {
          const t = pickTask(cwd);
          task = t ? { text: t.text, lineNo: t.lineNo } : null;
        }
        if (!task) {
          ctx.ui.notify("dev-loop: no more tasks", "info");
          break;
        }
        const merged = await runTask(pi, ctx, task.text, { dryRun, maxRounds, yes });
        if (merged && task.lineNo) markDone(cwd, task.lineNo);
        if (oneOff) break;
        if (!all) {
          ctx.ui.notify("dev-loop: one task done (use --all to continue)", "info");
          break;
        }
      }
    },
  });
}
