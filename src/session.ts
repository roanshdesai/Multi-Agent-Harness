import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  query,
  createSdkMcpServer,
  type Options,
  type Query,
  type SDKMessage,
  type SdkPluginConfig,
  type SDKUserMessage,
  type SDKControlGetContextUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";
import { buildAgents } from "./agents.js";
import { designPrompt, normalize, SUBAGENT_SCHEMA, type CustomSubagent } from "./subagents.js";
import { buildExternalMcp } from "./mcp.js";
import { designLibraryTool } from "./tools/design-library.js";
import { guiTestTool } from "./tools/gui-test.js";
import { askGptTool, imageTool } from "./tools/gpt.js";
import { pushApprovalHook, stuckDetector, type Ask } from "./guards.js";
import { assertClaudeSubscription, subscriptionEnv } from "./subscription.js";
import { HARNESS_COMMANDS, mergeCommands, type CommandInfo } from "./commands.js";
import { loadCustomServers, loadDisabled, readConnections, type ConnectionInfo } from "./connections.js";
import { toSnapshot, saveUsage, loadUsage, isExhausted, type UsageSnapshot } from "./usage.js";

/** A pushable stream of user messages, so a running task can take corrections (/change). */
export function inputChannel() {
  const buf: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const it = (async function* () {
    while (true) {
      if (buf.length) {
        yield buf.shift()!;
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  })();
  return {
    it,
    push(text: string, priority?: "next" | "now") {
      if (done) return false;
      buf.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(priority && { priority }) } as SDKUserMessage);
      wake?.();
      return true;
    },
    get pending() {
      return buf.length;
    },
    close() {
      done = true;
      wake?.();
    },
  };
}

/** Tokens in the context window by category, like Claude Code's /context grid. */
export interface ContextInfo {
  model: string;
  total: number;
  max: number;
  percentage: number;
  categories: { id: string; name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
  /** Claude Code's /context grid: rows of squares, each tagged with its category and how full it is. */
  grid: { id: string; fill: number }[][];
}

export function toContextInfo(u: SDKControlGetContextUsageResponse): ContextInfo {
  const idByName = new Map(u.categories.map((c) => [c.name, c.id ?? c.name]));
  return {
    model: u.model,
    total: u.totalTokens,
    max: u.rawMaxTokens || u.maxTokens,
    percentage: u.percentage,
    categories: u.categories.filter((c) => c.tokens > 0).map((c) => ({ id: c.id ?? c.name, name: c.name, tokens: c.tokens, kind: c.kind })),
    grid: (u.gridRows ?? []).map((row) => row.map((sq) => ({ id: idByName.get(sq.categoryName) ?? "free_space", fill: sq.isFilled ? sq.squareFullness || 1 : 0 }))),
  };
}

/** One question the agent asks you (AskUserQuestion). */
export interface AgentQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export type QuestionHandler = (questions: AgentQuestion[]) => Promise<Record<string, string>>;

// The SDK warns that canUseTool is "shadowed" under bypassPermissions. It is
// still called for AskUserQuestion, which is the only thing we use it for.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
  const code = typeof rest[0] === "object" && rest[0] ? (rest[0] as { code?: string }).code : rest[1];
  if (String(code ?? w).includes("CAN_USE_TOOL_SHADOWED")) return;
  return (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const ORCHESTRATOR_PROMPT = `
# Harness routing rules
You are the main orchestrator. You plan, delegate and integrate; specialists on other models do the work.
Delegation is mandatory, even for small tasks: do not fetch web pages, curl URLs, search the web, or write code yourself. Only answer directly when the reply needs no tools (chat, clarifying questions, summarizing results you already have).
Delegate with the Agent tool:
- Any coding (features, fixes, tests, scripts, refactors) → "coder" (Fable). Do not write non-trivial code yourself.
- Research, scraping, web lookups, data gathering, general reading tasks → "researcher" (Sonnet). Run several in parallel when the work splits.
- Long pages, logs or transcripts → "summarizer" before you read them.
- UI/visual design → "designer". It must ground work in the design_library tool.
- Testing a UI in a browser → "gui-tester".
- Images (generate, edit, review screenshots) → "image" (runs on GPT-6.1 Sol through Codex).
- Video → "video".
- The user's own subagents (from /subagents) are listed with the Agent tool. Prefer them when their description fits.
- If the user asks for GPT or a GPT model's opinion, use mcp__harness__ask_gpt.
- Stuck (repeated failures, unclear root cause) or a hard trade-off → "advisor" (Fable) before continuing.
- Before presenting a worker's result as done, or before any commit, have "verifier" check it. If it says FAIL, send the fix back to the worker.

# Memory
- At the start of a new task, recall relevant past experience from Hindsight (mcp__hindsight__* recall/reflect tools) and claude-mem search if available.
- When a task finishes, retain the lessons: what worked, what failed, user preferences, project facts. Keep each memory short and specific.

# Workflow skills
Superpowers (brainstorming → writing-plans → executing-plans, TDD, systematic-debugging, verification-before-completion) and gstack (/plan-ceo-review, /plan-eng-review, /review, /qa, /ship) are available. Use them when they fit the task.

# Integrations
GitHub, Slack and Outlook are available as MCP tools. Pushing to GitHub needs the user's approval, which the harness asks for automatically; never push to main or master.
`;

/** Every directory under plugins_dir (depth ≤ 2) that contains .claude-plugin/plugin.json. */
export function discoverPlugins(dir: string): SdkPluginConfig[] {
  if (!existsSync(dir)) return [];
  const found: SdkPluginConfig[] = [];
  const visit = (d: string, depth: number) => {
    if (existsSync(join(d, ".claude-plugin", "plugin.json"))) {
      found.push({ type: "local", path: d });
      return;
    }
    if (depth === 0) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") visit(join(d, e.name), depth - 1);
    }
  };
  for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) visit(join(dir, e.name), 2);
  return found;
}

export interface TurnResult {
  sessionId: string;
  text: string;
  isError: boolean;
  numTurns: number;
  costUsd: number;
  agentsUsed: string[];
  structured?: unknown;
  /** Claude refused because the plan's usage limit is reached. */
  rateLimited?: boolean;
}

export interface TurnHooks {
  onMessage?: (m: SDKMessage) => void;
  onQuery?: (q: Query) => void;
  /** Receives a function that sends a correction into the running task. */
  onSteer?: (steer: (text: string) => boolean) => void;
  /** Called with the context breakdown when the turn ends. */
  onContext?: (c: ContextInfo) => void;
}

export class Harness {
  readonly mcpSkipped: string[];
  readonly plugins: SdkPluginConfig[];
  modelOverride?: string;
  verifyEnabled: boolean;
  /** Claude plan name once the subscription check has passed. */
  plan?: string;
  /** Answers the agent's questions (AskUserQuestion). Set by the app or terminal. */
  onQuestion?: QuestionHandler;
  /** Latest Claude plan usage (5-hour and weekly windows). */
  usage: UsageSnapshot | null;
  onUsage?: (s: UsageSnapshot) => void;

  constructor(
    readonly cfg: HarnessConfig,
    private ask: Ask,
    /** Workspace folder for this harness, fixed at creation so a later folder change can't move a running tab. */
    readonly cwd: string = process.cwd(),
  ) {
    this.mcpSkipped = buildExternalMcp(cfg).skipped;
    this.plugins = discoverPlugins(cfg.plugins_dir);
    this.verifyEnabled = cfg.verify.enabled;
    this.usage = loadUsage(cfg);
    mkdirSync(join(cfg.root, ".harness", "scratch"), { recursive: true });
  }

  get mainModel() {
    return this.modelOverride ?? this.cfg.models.main;
  }

  /** Full option set for a main-agent turn. */
  options(extra: Partial<Options> = {}): Options {
    const cfg = this.cfg;
    const local = createSdkMcpServer({
      name: "harness",
      version: "1.0.0",
      tools: [
        designLibraryTool(cfg.design_library),
        guiTestTool(cfg.models.gui, cfg.root),
        askGptTool(cfg.root, cfg.models.gpt),
        imageTool(cfg.root, cfg.models.image, cfg.models.image_fallback),
      ],
    });
    const stuck = stuckDetector(cfg);
    return {
      cwd: this.cwd,
      // Subscription-only: strip every API-key credential so billing can't fall back to the API.
      ...(cfg.auth.subscription_only && { env: subscriptionEnv() }),
      // Packaged desktop app: the engine binary lives outside the asar archive.
      ...(process.env.HARNESS_CLAUDE_BIN && { pathToClaudeCodeExecutable: process.env.HARNESS_CLAUDE_BIN }),
      model: this.mainModel,
      fallbackModel: cfg.models.fallback.join(","),
      effort: cfg.effort.main,
      systemPrompt: { type: "preset", preset: "claude_code", append: ORCHESTRATOR_PROMPT },
      agents: buildAgents(cfg),
      mcpServers: { harness: local, ...buildExternalMcp(cfg).servers, ...loadCustomServers(cfg) },
      // Like Claude Code: the working model consults a stronger advisor on its own when it hits something hard.
      ...(cfg.advisor.auto && { settings: { advisorModel: cfg.models.advisor } }),
      // Only AskUserQuestion reaches this under bypassPermissions: the agent asking you something.
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName !== "AskUserQuestion") return { behavior: "allow" as const, updatedInput: input };
        const questions = (input.questions ?? []) as AgentQuestion[];
        if (!this.onQuestion) return { behavior: "deny" as const, message: "No one is available to answer questions right now. Make a sensible assumption, say what you assumed, and continue." };
        const answers = await this.onQuestion(questions);
        return { behavior: "allow" as const, updatedInput: { ...input, answers } };
      },
      plugins: this.plugins,
      // user settings → ~/.claude/skills (gstack), project settings → .claude/
      settingSources: ["user", "project", "local"],
      // Everything runs without prompts; the push hook below is the only gate.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      sandbox: cfg.sandbox.enabled
        ? {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            failIfUnavailable: cfg.sandbox.fail_if_unavailable,
            network: { allowLocalBinding: true },
          }
        : undefined,
      hooks: {
        PreToolUse: [{ matcher: "Bash|mcp__github__.*", ...pushApprovalHook(cfg, this.ask) }],
        PostToolUseFailure: [stuck.onFailure],
        PostToolUse: [stuck.onSuccess],
      },
      ...extra,
    } as Options;
  }

  /** Every command available: the harness's own plus plugin/skill commands the session reports. */
  commands: CommandInfo[] = HARNESS_COMMANDS;

  /**
   * Start a session without sending a prompt to (1) confirm the Claude login is a
   * subscription and (2) collect the slash commands plugins and skills provide.
   */
  async checkAuth(): Promise<string | undefined> {
    const idle = (async function* () {
      await new Promise(() => {});
    })() as AsyncIterable<never>;
    const q = query({ prompt: idle, options: this.options({ persistSession: false }) });
    try {
      try {
        this.commands = mergeCommands(await q.supportedCommands());
      } catch {
        /* keep the built-in list */
      }
      if (!this.cfg.auth.subscription_only) return undefined;
      this.plan = assertClaudeSubscription(await q.accountInfo());
      return this.plan;
    } finally {
      q.close();
    }
  }

  /** Run one prompt to completion, streaming messages to the hooks. */
  async run(prompt: string, opts: Partial<Options>, hooks: TurnHooks = {}): Promise<TurnResult> {
    // Streaming input keeps the task open to corrections while it runs.
    const input = inputChannel();
    input.push(prompt);
    const q = query({ prompt: input.it, options: this.options(opts) });
    hooks.onQuery?.(q); // as early as possible, so Stop works from the first moment
    hooks.onSteer?.((text) => input.push(text, "next"));
    for (const name of loadDisabled(this.cfg)) await q.toggleMcpServer(name, false).catch(() => {});
    if (this.cfg.auth.subscription_only && !this.plan) {
      try {
        this.plan = assertClaudeSubscription(await q.accountInfo());
      } catch (err) {
        input.close();
        q.close();
        throw err;
      }
    }
    const res: TurnResult = { sessionId: "", text: "", isError: false, numTurns: 0, costUsd: 0, agentsUsed: [] };
    for await (const m of q) {
      if ("session_id" in m && m.session_id) res.sessionId = m.session_id;
      if (m.type === "rate_limit_event") {
        this.usage = toSnapshot(m.rate_limit_info);
        saveUsage(this.cfg, this.usage);
        this.onUsage?.(this.usage);
      }
      if (m.type === "assistant" && m.error === "rate_limit") res.rateLimited = true;
      if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
            const t = (b.input as any)?.subagent_type;
            if (t) res.agentsUsed.push(t);
          }
        }
      }
      if (m.type === "result") {
        res.isError = m.is_error;
        res.numTurns = m.num_turns;
        res.costUsd = m.total_cost_usd;
        res.text = m.subtype === "success" ? m.result : `(${m.subtype})`;
        if (m.is_error && isExhausted(this.usage)) res.rateLimited = true;
        if (m.subtype === "success") res.structured = m.structured_output;
        hooks.onMessage?.(m);
        // A correction that arrived just as the turn ended starts one more turn; otherwise we're done.
        if (input.pending === 0) {
          if (hooks.onContext) {
            const ctx = await q.getContextUsage({ detail: "summary" }).catch(() => null);
            if (ctx) hooks.onContext(toContextInfo(ctx));
          }
          input.close();
        }
        continue;
      }
      hooks.onMessage?.(m);
    }
    input.close();
    return res;
  }

  /** Context breakdown for a saved chat, without sending anything. */
  async contextFor(sessionId: string): Promise<ContextInfo | null> {
    const input = inputChannel();
    const q = query({ prompt: input.it, options: this.options({ resume: sessionId, persistSession: false }) });
    try {
      return toContextInfo(await q.getContextUsage({ detail: "summary" }));
    } catch {
      return null;
    } finally {
      input.close();
      q.close();
    }
  }

  /** Every MCP server and app the agents can reach, with live status. */
  async connections(reconnect?: string): Promise<ConnectionInfo[]> {
    const idle = (async function* () {
      await new Promise(() => {});
    })() as AsyncIterable<never>;
    const q = query({ prompt: idle, options: this.options({ persistSession: false }) });
    try {
      if (reconnect) await q.reconnectMcpServer(reconnect).catch(() => {});
      return await readConnections(q, this.cfg, Object.keys(buildExternalMcp(this.cfg).servers));
    } finally {
      q.close();
    }
  }

  /**
   * /subagents: the Fable advisor designs subagents from a description, or,
   * with an empty request, looks at the project and suggests some. Nothing is
   * saved here; the caller shows the proposal and saves on approval.
   */
  async designSubagents(request: string): Promise<{ summary: string; subagents: CustomSubagent[] }> {
    const cfg = this.cfg;
    const existing = Object.entries(buildAgents(cfg)).map(([name, a]) => ({ name, description: a.description }));
    const r = await this.run(designPrompt(request, existing, cfg), {
      model: cfg.models.advisor,
      effort: "high", // designing agent definitions doesn't need the advisor's deepest setting
      persistSession: false,
      outputFormat: { type: "json_schema", schema: SUBAGENT_SCHEMA as unknown as Record<string, unknown> },
      disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash", "Agent", "mcp__github__*", "mcp__slack__*", "mcp__outlook__*"],
      maxTurns: 30,
    });
    const out = r.structured as { summary?: string; subagents?: CustomSubagent[] } | undefined;
    if (!out?.subagents?.length) throw new Error(r.isError ? r.text : "The advisor didn't propose any subagents. Try describing what you need.");
    const allowed = new Set([cfg.models.main, cfg.models.advisor, cfg.models.worker, cfg.models.video, ...cfg.models.gpt]);
    const subagents = out.subagents.map((a) => normalize({ ...a, model: allowed.has(a.model) ? a.model : cfg.models.worker }));
    return { summary: out.summary ?? "", subagents };
  }

  /**
   * Independent verification pass (item 3). Runs on a throwaway fork of the
   * session so the verifier sees full context but adds nothing to the chat.
   */
  async verify(sessionId: string, hooks: TurnHooks = {}): Promise<{ pass: boolean; feedback: string }> {
    const r = await this.run(
      `You are now acting as the VERIFIER for the conversation above. Check the assistant's last answer against what the user asked: re-run tests, open changed files, re-check sources where relevant. Do not modify files.
Reply with first line "VERDICT: PASS" or "VERDICT: FAIL", then the specific problems and fixes.`,
      {
        resume: sessionId,
        forkSession: true,
        model: this.cfg.models.verifier,
        effort: this.cfg.effort.verifier,
        persistSession: false,
        disallowedTools: ["Write", "Edit", "NotebookEdit", "mcp__github__*"],
        maxTurns: 25,
      },
      hooks,
    );
    const pass = /VERDICT:\s*PASS/i.test(r.text) && !r.isError;
    return { pass, feedback: r.text };
  }
}
