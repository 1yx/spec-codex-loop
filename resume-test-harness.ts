import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerDevLoop from "./src/dev-loop.ts";
import { writeLoopState } from "./src/control.ts";
import { rt, type LoopCtx, type LoopState } from "./src/runtime.ts";

type AgentStep = { error?: string; intermediateError?: string; commitOnError?: boolean; noCommit?: boolean; crash?: "after" | "before"; delayMs?: number };
type CrashSpec = { count?: number; when: "after" | "before" };
type EventHandler = (event?: unknown) => unknown;
type CommandHandler = (args: unknown, ctx: LoopCtx) => void | Promise<void>;

export type HarnessOptions = {
  agentSteps?: AgentStep[];
  fetchFailures?: number;
  mergeChangesHead?: number;
  reviewMode?: "error" | "pass" | "pending" | "quota" | "suggestions";
  passAfterAgent?: boolean;
  failures?: Record<string, number>;
  prOpen?: boolean;
  statusDirty?: boolean;
  unmerged?: boolean;
  crashes?: Record<string, CrashSpec>;
}

export class ResumeHarness {
  readonly root = mkdtempSync(join(tmpdir(), "spec-loop-resume-"));
  readonly change = "test-change";
  readonly prNum = 42;
  readonly notifications: Array<{ message: string; level?: string }> = [];
  readonly commands: string[][] = [];
  readonly agentPrompts: string[] = [];
  readonly postedComments: string[] = [];
  readonly trackedFiles = new Set<string>();
  readonly ctx: LoopCtx;
  readonly pi: ExtensionAPI;
  head = "aaaaaaa111111111111111111111111111111111";
  remoteHead = this.head;
  fetchFailures: number;
  mergeChangesHead: number;
  reviewMode: "error" | "pass" | "pending" | "quota" | "suggestions";
  unmerged: boolean;
  prOpen: boolean;
  prMerged = false;
  statusDirty: boolean;
  openspecTracked = false;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly agentSteps: AgentStep[];
  private readonly passAfterAgent: boolean;
  private readonly failures: Record<string, number>;
  private readonly crashes: Record<string, Required<CrashSpec>>;
  private readonly branches = new Map<string, { merged: boolean; open: boolean }>();
  private loopHandler: CommandHandler | null = null;
  private shaCounter = 0;

  // eslint-disable-next-line complexity
  constructor(options: HarnessOptions = {}) {
    this.fetchFailures = options.fetchFailures ?? 0;
    this.mergeChangesHead = options.mergeChangesHead ?? 0;
    this.reviewMode = options.reviewMode ?? "pass";
    this.passAfterAgent = options.passAfterAgent ?? false;
    this.unmerged = options.unmerged ?? false;
    this.prOpen = options.prOpen ?? true;
    this.statusDirty = options.statusDirty ?? false;
    this.agentSteps = [...(options.agentSteps ?? [])];
    this.failures = { ...(options.failures ?? {}) };
    this.crashes = Object.fromEntries(Object.entries(options.crashes ?? {}).map(([key, value]) => [key, { count: value.count ?? 1, when: value.when }]));
    this.ctx = {
      cwd: this.root,
      ui: { notify: (message, level) => this.notifications.push({ message, level }) },
    };
    mkdirSync(join(this.root, "openspec"), { recursive: true });
    this.pi = {
      on: (event: string, handler: EventHandler) => { this.handlers.set(event, handler); },
      registerCommand: (_name: string, command: { handler: CommandHandler }) => { this.loopHandler = command.handler; },
      exec: (command: string, args: string[]) => this.exec(command, args),
      sendUserMessage: (prompt: string) => this.sendAgent(prompt),
    } as unknown as ExtensionAPI;
    this.resetRuntime();
    registerDevLoop(this.pi);
  }

  state(overrides: Partial<LoopState> = {}): LoopState {
    return {
      phase: "review", inner: "review_probe", round: 1, prNum: this.prNum,
      head: this.head, repo: "owner/repo", triggerAt: null, reviewDeadline: null,
      seenSignatures: [], suggestions: [], stopReason: "test_stop", oneOff: true,
      ...overrides,
    };
  }

  persist(state: LoopState, change = this.change): void {
    mkdirSync(join(this.root, ".worktree", change), { recursive: true });
    writeLoopState(this.root, change, state);
  }

  stateExists(change = this.change): boolean {
    return existsSync(join(this.root, ".worktree", change, ".loop-state.json"));
  }

  async resume(): Promise<void> {
    await this.run("resume");
  }

  async run(args: string): Promise<void> {
    assert.ok(this.loopHandler, "extension did not register /loop");
    await this.loopHandler(args, this.ctx);
  }

  restart(): void {
    this.resetRuntime();
    registerDevLoop(this.pi);
  }

  track(path: string): void {this.trackedFiles.add(path);}

  dispose(): void {
    this.resetRuntime();
    rmSync(this.root, { recursive: true, force: true });
  }

  private nextHead(): string {
    this.shaCounter++;
    return `${String(this.shaCounter + 1).repeat(7)}${String(this.shaCounter).repeat(33)}`.slice(0, 40);
  }

  private resetRuntime(): void {
    for (const timer of rt.waitTimers.values()) {clearTimeout(timer);}
    rt.waitTimers.clear();
    if (rt.sentinelTicker) {clearInterval(rt.sentinelTicker);}
    rt.piRef = null; rt.runCtx = null; rt.loopActive = false; rt.stepping = false;
    rt.interruptedChange = null; rt.stopRequested = false; rt.fetchRequested = false;
    rt.sentinelTicker = null; rt.turnResolve = null; rt.turnResult = null; rt.loopLockPath = null; rt.wakeLoop = null;
  }

  // eslint-disable-next-line complexity
  private sendAgent(prompt: string): void {
    this.agentPrompts.push(prompt);
    const step = this.agentSteps.shift() ?? {};
    if (step.crash === "before") {throw new Error("simulated agent crash before side effect");}
    const failed = !!step.error;
    if ((!failed && !step.noCommit) || step.commitOnError) {this.head = this.nextHead();}
    if (!failed && prompt.includes("origin/main advanced")) {this.unmerged = false;}
    if (!failed && this.passAfterAgent) {this.reviewMode = "pass";}
    if (step.crash === "after") {throw new Error("simulated agent crash after side effect");}
    const settle = () => {
      if (step.intermediateError) {
        this.handlers.get("agent_end")?.({
          messages: [{ role: "assistant", stopReason: "error", errorMessage: step.intermediateError }],
        });
      }
      this.handlers.get("agent_end")?.({
        messages: [{ role: "assistant", stopReason: failed ? "error" : "stop", errorMessage: step.error }],
      });
      this.handlers.get("agent_settled")?.();
    };
    if (step.delayMs) {setTimeout(settle, step.delayMs);} else {setImmediate(settle);}
  }

  // eslint-disable-next-line complexity
  private exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const call = [command, ...args];
    this.commands.push(call);
    const crash = this.commandCrash(call);
    if (crash === "before") {return Promise.reject(new Error(`simulated crash before ${call.join(" ")}`));}
    const failure = this.commandFailure(call);
    if (failure) {return failure;}
    let result: Promise<{ code: number; stdout: string; stderr: string }>;
    if (command === "sh") {result = this.ok();}
    if (command === "openspec") {
      if (args[0] === "init") {mkdirSync(join(this.root, "openspec"), { recursive: true });}
      if (args[0] === "archive") {rmSync(join(this.root, ".worktree", args[1] ?? this.change, "openspec", "changes", args[1] ?? this.change), { recursive: true, force: true });}
      result = this.ok();
    } else if (command === "git") {
      result = this.gitExec(args);
    } else if (command === "gh") {
      result = this.ghExec(args);
    } else {
      result ??= Promise.resolve({ code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` });
    }
    return crash === "after" ? result.then(() => Promise.reject(new Error(`simulated crash after ${call.join(" ")}`))) : result;
  }

  private commandCrash(call: string[]): "after" | "before" | null {
    const joined = call.join(" ");
    const key = Object.keys(this.crashes).find((candidate) => joined.startsWith(candidate));
    if (!key || this.crashes[key].count <= 0) {return null;}
    this.crashes[key].count--;
    return this.crashes[key].when;
  }

  private commandFailure(call: string[]): Promise<{ code: number; stdout: string; stderr: string }> | null {
    const joined = call.join(" ");
    const key = Object.keys(this.failures).find((candidate) => joined.startsWith(candidate));
    if (!key || this.failures[key] <= 0) {return null;}
    this.failures[key]--;
    return Promise.resolve({ code: 1, stdout: "", stderr: `transient ${key} failure` });
  }

  private ok(stdout = ""): Promise<{ code: number; stdout: string; stderr: string }> {
    return Promise.resolve({ code: 0, stdout, stderr: "" });
  }

  // Branch-heavy by design: this is a deterministic command simulator.
  // eslint-disable-next-line complexity
  private gitExec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (args[0] === "fetch") {
      if (this.fetchFailures > 0) {this.fetchFailures--; return Promise.resolve({ code: 1, stdout: "", stderr: "network down" });}
      return this.ok();
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {return this.ok("main");}
    if (args[0] === "rev-parse" && args[1] === "HEAD") {return this.ok(this.head);}
    if (args[0] === "rev-parse" && args[1]?.startsWith("origin/")) {return this.ok(this.remoteHead);}
    if (args[0] === "merge-base") {return this.ok();}
    if (args[0] === "merge") {return this.gitMerge(args);}
    if (args[0] === "diff") {return this.ok(this.unmerged ? "src/conflict.ts" : "");}
    if (args[0] === "status") {return this.ok(this.statusDirty ? "M changed" : "");}
    if (args[0] === "ls-files") {
      const target = args.at(-1) ?? "";
      if (target === "openspec/") {return this.ok(this.openspecTracked ? "openspec/config.yaml" : "");}
      return this.ok(this.trackedFiles.has(target) ? target : "");
    }
    if (args[0] === "add") {
      for (const path of args.slice(1)) {if (path === "openspec/") {this.openspecTracked = true;} else {this.trackedFiles.add(path);}}
      return this.ok();
    }
    if (args[0] === "commit") {this.head = this.nextHead(); return this.ok();}
    if (args[0] === "push") {this.remoteHead = this.head; return this.ok();}
    if (args[0] === "worktree" && args[1] === "add") {
      const wtDir = args[4] ?? "";
      mkdirSync(wtDir, { recursive: true });
      if (existsSync(join(this.root, "openspec"))) {cpSync(join(this.root, "openspec"), join(wtDir, "openspec"), { recursive: true });}
      return this.ok();
    }
    if (args[0] === "worktree" && args[1] === "remove") {rmSync(args[3] ?? "", { recursive: true, force: true }); return this.ok();}
    return this.ok();
  }

  private gitMerge(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (args[1] === "origin/main" && args.includes("--no-edit") && this.mergeChangesHead > 0) {
      this.mergeChangesHead--;
      this.head = this.nextHead();
    }
    if (args[1] === "--abort") {this.unmerged = false;}
    return this.ok();
  }

  // eslint-disable-next-line complexity
  private ghExec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (args[0] === "pr" && args[1] === "list") {
      const headAt = args.indexOf("--head");
      const branch = args[headAt + 1] ?? this.change;
      const state = this.branches.get(branch) ?? { open: branch === this.change && this.prOpen, merged: branch === this.change && this.prMerged };
      if (args.includes("open")) {return this.ok(state.open ? String(this.prNum) : "");}
      return this.ok(args.includes("merged") && state.merged ? String(this.prNum) : "");
    }
    if (args[0] === "pr" && args[1] === "view") {return this.ok(this.remoteHead);}
    if (args[0] === "pr" && args[1] === "create") {
      const headAt = args.indexOf("--head");
      this.branches.set(args[headAt + 1] ?? this.change, { open: true, merged: false });
      this.prOpen = true;
      return this.ok();
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const bodyAt = args.indexOf("--body");
      if (bodyAt >= 0) {this.postedComments.push(args[bodyAt + 1] ?? "");}
      return this.ok();
    }
    if (args[0] === "pr" && args[1] === "merge") {
      const branch = rt.runCtx?.change ?? this.change;
      this.branches.set(branch, { open: false, merged: true });
      this.prOpen = false; this.prMerged = true;
      const wtTodo = join(this.root, ".worktree", branch, "TODO.md");
      if (existsSync(wtTodo)) {copyFileSync(wtTodo, join(this.root, "TODO.md"));}
      return this.ok();
    }
    if (args[0] === "repo") {return this.ok("owner/repo");}
    if (args[0] === "api") {return this.ghApi(args[1] ?? "");}
    return this.ok();
  }

  private ghApi(endpoint: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const json = (value: unknown) => Promise.resolve({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    if (endpoint === `repos/owner/repo/pulls/${this.prNum}`) {return Promise.resolve({ code: 0, stdout: "clean", stderr: "" });}
    if (endpoint.endsWith("/reactions?per_page=100")) {return json([]);}
    if (endpoint.endsWith("/reviews?per_page=100")) {
      return json(this.reviewMode === "suggestions" ? [{ id: 7, user: { login: "chatgpt-codex-connector" }, state: "COMMENTED", submitted_at: "2026-07-22T00:01:00Z", commit_id: this.head }] : []);
    }
    if (endpoint.endsWith(`/pulls/${this.prNum}/comments?per_page=100`)) {
      return json(this.reviewMode === "suggestions" ? [{ id: 8, pull_request_review_id: 7, user: { login: "chatgpt-codex-connector" }, created_at: "2026-07-22T00:01:00Z", body: "**Fix issue**\nbody", path: "src/a.ts", line: 1, commit_id: this.head }] : []);
    }
    if (endpoint.endsWith(`/issues/${this.prNum}/comments?per_page=100`)) {
      const bodies: Partial<Record<ResumeHarness["reviewMode"], string>> = {
        pass: `Didn't find any major issues. Reviewed commit: ${this.head.slice(0, 7)}`,
        quota: "Code review usage limits reached",
        error: "Something went wrong while reviewing this PR",
      };
      const body = bodies[this.reviewMode];
      const codex = body ? [{ id: 1, user: { login: "chatgpt-codex-connector" }, created_at: "2026-07-22T00:01:00Z", body }] : [];
      const posted = this.postedComments.map((comment, index) => ({ id: 100 + index, user: { login: "test-user" }, created_at: `2026-07-22T00:0${index + 2}:00Z`, body: comment }));
      return json([...codex, ...posted]);
    }
    return json([]);
  }
}
