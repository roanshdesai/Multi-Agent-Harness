import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HarnessConfig } from "./config.js";
import { runCodex, type CodexEvent } from "./codex.js";
import { codexStatus } from "./subscription.js";
import type { ChatEvent, ChatSummary, Engine, HistoryItem } from "./engine.js";
import type { ContextInfo } from "./session.js";
import { instinctsBlock } from "./instincts.js";
import { contextBlock } from "./project-context.js";
import { bankFor, bankMcpUrl } from "./projects.js";

interface StoredGptChat {
  id: string;
  title: string;
  model: string;
  cwd: string;
  updated: number;
  items: HistoryItem[];
  /** Codex thread to resume. A fork has none until its first turn (it starts from the copied transcript). */
  thread?: string | null;
  /** Tokens in the conversation after the last turn, for the context grid. */
  lastInput?: number;
}

/**
 * What a GPT tab is told when a Codex thread starts, so it works like a Claude
 * tab in the same project: the project's pinned files and links, the lessons
 * learned about how the user works, and the project's memory (Hindsight).
 */
export function gptPreamble(cfg: HarnessConfig, cwd: string): string {
  const extra = instinctsBlock(cfg, cwd) + contextBlock(cfg, cwd);
  const memory = cfg.mcp?.hindsight && cfg.memory?.hindsight_mcp
    ? "\n# Memory\nThis project's long-term memory is the `harness_memory` MCP server (Hindsight): recall from it before starting work that may have history, and retain short lessons when you finish."
    : "";
  return extra || memory ? `[Notes from the harness for this chat]${memory}${extra}\n[End of notes]\n\n` : "";
}

/** The model's context window from Codex's model list (~/.codex/models_cache.json). */
function contextWindow(model: string): number {
  try {
    const d = JSON.parse(readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8")) as { models?: { slug?: string; context_window?: number; effective_context_window_percent?: number }[] };
    const m = (d.models ?? []).find((x) => x.slug === model);
    if (m?.context_window) return Math.round(m.context_window * ((m.effective_context_window_percent ?? 100) / 100));
  } catch {
    /* no cache */
  }
  return 272_000;
}

const dirFor = (cfg: HarnessConfig) => join(cfg.root, ".harness", "gpt-chats");

/** GPT chats, for one folder or (without `cwd`) for every folder. */
export function listGptChats(cfg: HarnessConfig, cwd?: string): ChatSummary[] {
  const dir = dirFor(cfg);
  if (!existsSync(dir)) return [];
  const out: ChatSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredGptChat;
      if (cwd === undefined || c.cwd === cwd) out.push({ id: c.id, title: c.title, updated: c.updated, kind: "gpt", model: c.model, cwd: c.cwd });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export function isGptChat(cfg: HarnessConfig, id: string): boolean {
  return existsSync(join(dirFor(cfg), `${id}.json`));
}

/**
 * A chat tab running on a GPT model through Codex (ChatGPT subscription).
 * Codex keeps the conversation; we keep a readable transcript for the sidebar and tabs.
 */
export class GptChat implements Engine {
  readonly kind = "gpt" as const;
  sessionId?: string;
  busy = false;
  private child: ChildProcess | null = null;
  private queue: string[] = [];
  private items: HistoryItem[] = [];
  private title = "";
  /** The Codex thread this chat resumes (undefined: the next turn starts a new one). */
  private thread?: string;
  private lastInput = 0;
  /** A /change sent while busy: the current step is stopped and this runs next. */
  private correction: string | null = null;

  /** Fast mode for this tab (/fast); starts from codex.fast in harness.config.yaml. */
  fast: boolean;

  constructor(
    private cfg: HarnessConfig,
    public model: string,
    private emit: (e: ChatEvent) => void,
    readonly cwd = process.cwd(),
  ) {
    this.fast = cfg.codex?.fast === true;
  }

  private file(id: string) {
    return join(dirFor(this.cfg), `${id}.json`);
  }

  private save() {
    if (!this.sessionId) return;
    mkdirSync(dirFor(this.cfg), { recursive: true });
    const data: StoredGptChat = { id: this.sessionId, title: this.title, model: this.model, cwd: this.cwd, updated: Date.now(), items: this.items, thread: this.thread ?? null, lastInput: this.lastInput };
    writeFileSync(this.file(this.sessionId), JSON.stringify(data, null, 1));
  }

  send(text: string, source?: string, prompt = text) {
    this.emit({ type: "user", text, queued: this.busy, source });
    if (this.busy) {
      this.queue.push(prompt);
      return;
    }
    void this.runTurn(prompt);
  }

  async stop() {
    this.queue.length = 0;
    this.child?.kill("SIGINT");
  }

  newChat() {
    this.sessionId = undefined;
    this.thread = undefined;
    this.items = [];
    this.title = "";
    this.lastInput = 0;
  }

  resume(id: string) {
    const c = JSON.parse(readFileSync(this.file(id), "utf8")) as StoredGptChat;
    this.sessionId = c.id;
    this.items = c.items;
    this.title = c.title;
    this.model = c.model;
    this.lastInput = c.lastInput ?? 0;
    // Older chats used the Codex thread id as their id; a fork has no thread yet.
    this.thread = c.thread === null ? undefined : (c.thread ?? c.id);
    if (!this.thread && this.items.length) this.pendingContext = forkSeed(this.items, this.title);
    this.emit({ type: "session", id });
  }

  async history(id: string): Promise<HistoryItem[]> {
    if (id !== this.sessionId) this.resume(id);
    return this.items;
  }

  async btw(question: string): Promise<string> {
    const context = this.items
      .slice(-12)
      .map((i) => `${i.role}: ${i.text}`)
      .join("\n")
      .slice(-6000);
    const r = await runCodex({
      root: this.cfg.root,
      model: this.model,
      cwd: this.cwd,
      sandbox: "read-only",
      ephemeral: true,
      prompt: `Recent conversation:\n${context}\n\nSide question (answer briefly, do not do any work): ${question}`,
    }).done;
    return r.ok ? r.text : `(${r.error})`;
  }

  /**
   * Copy this chat into a new one. Codex can't duplicate a thread, so the copy
   * starts a fresh thread from the transcript on its first message.
   */
  async fork(title?: string): Promise<string> {
    if (!this.sessionId) throw new Error("Nothing to fork yet: send a message first.");
    const id = `gptfork-${Date.now().toString(36)}`;
    const data: StoredGptChat = { id, title: title || `${this.title || "Chat"} (fork)`, model: this.model, cwd: this.cwd, updated: Date.now(), items: [...this.items], thread: null, lastInput: this.lastInput };
    mkdirSync(dirFor(this.cfg), { recursive: true });
    writeFileSync(this.file(id), JSON.stringify(data, null, 1));
    return id;
  }

  /**
   * /change: correct the running task. Codex can't take input mid-turn, so the
   * current step is stopped and the conversation carries on at once with the
   * correction (the thread keeps everything done so far).
   */
  change(text: string, source?: string) {
    if (!this.busy || !this.child) return this.send(text, source);
    this.emit({ type: "user", text, queued: false, source });
    this.emit({ type: "note", text: "Stopping the current step and continuing with your correction." });
    this.correction = text;
    this.child.kill("SIGINT");
  }

  /**
   * /handoff for a GPT chat: write the conversation as context.md (no model
   * call needed) so "Continue in a new chat" can start from it, as for Claude.
   */
  async handoff(): Promise<{ file: string; text: string } | null> {
    if (!this.sessionId || !this.items.length) {
      this.emit({ type: "handoff", status: "failed", error: "Nothing to hand off yet; send a message first." });
      return null;
    }
    const pct = (await this.context())?.percentage;
    const text = `# Hand-off: ${this.title || "GPT chat"}\n\nModel: ${this.model} · Folder: ${this.cwd}\n\n${forkSeed(this.items, this.title).replace(/^\[[^\]]*\]\n\n/, "## Conversation so far\n\n")}\n`;
    const dir = join(this.cfg.root, ".harness", "handoffs", this.sessionId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "context.md");
    writeFileSync(file, text);
    this.emit({ type: "handoff", status: "ready", percent: pct, file, text });
    return { file, text };
  }

  /** How full the context window is, from the last turn's token count. */
  async context(): Promise<ContextInfo | null> {
    if (!this.lastInput) return null;
    const max = contextWindow(this.model);
    const used = Math.min(this.lastInput, max);
    const pct = Math.round((used / max) * 1000) / 10;
    const cells = 100;
    const filled = Math.round((used / max) * cells);
    const grid: { id: string; fill: number }[][] = [];
    for (let r = 0; r < 10; r++) grid.push(Array.from({ length: 10 }, (_, c) => (r * 10 + c < filled ? { id: "messages", fill: 1 } : { id: "free", fill: 0 })));
    return {
      model: this.model,
      total: used,
      max,
      percentage: pct,
      categories: [
        { id: "messages", name: "Conversation (as Codex reports it)", tokens: used, kind: "used" },
        { id: "free", name: "Free space", tokens: max - used, kind: "free" },
      ],
      grid,
    };
  }

  answer(): boolean {
    return false; // Codex runs non-interactively; it doesn't ask questions mid-turn
  }

  /** Start this chat with context carried over from a Claude conversation. */
  seed(context: string) {
    this.pendingContext = context;
  }
  private pendingContext = "";

  async rename(title: string) {
    this.title = title;
    this.save();
  }

  private onCodexEvent = (e: CodexEvent) => {
    if (e.type === "thread.started" && e.thread_id) {
      this.thread = e.thread_id;
      if (!this.sessionId) {
        this.sessionId = e.thread_id;
        this.emit({ type: "session", id: e.thread_id });
      }
    }
    const it = e.item;
    if (!it) return;
    if (e.type === "item.completed" && it.type === "agent_message" && it.text) {
      this.items.push({ role: "assistant", text: it.text });
      this.emit({ type: "text", text: it.text });
      return;
    }
    // Codex subagents: show them like Claude's (an agent card, then its steps).
    if (it.type === "collab_tool_call") {
      if (e.type === "item.started" && it.tool === "spawn_agent") {
        this.items.push({ role: "tool", text: `subagent(${it.prompt ?? ""})` });
        this.emit({ type: "agent", id: it.id ?? String(Date.now()), agent: "GPT subagent", description: String(it.prompt ?? "").slice(0, 200) });
      } else if (e.type === "item.started") {
        const name = it.tool === "wait" ? "Waiting for subagents" : it.tool === "send_input" ? "Message to subagent" : `Subagent: ${it.tool ?? ""}`;
        this.emit({ type: "tool", id: it.id ?? String(Date.now()), name, summary: String(it.prompt ?? "").slice(0, 140), sub: true });
      } else if (e.type === "item.completed" && it.agents_states) {
        for (const [id, st] of Object.entries(it.agents_states)) if (st?.message) this.emit({ type: "tool", id: `${it.id}-${id}`, name: "Subagent replied", summary: String(st.message).slice(0, 140), sub: true });
      }
      return;
    }
    if (e.type !== "item.started") return;
    const tool =
      it.type === "command_execution"
        ? { name: "Shell", summary: it.command ?? "" }
        : it.type === "web_search"
          ? { name: "WebSearch", summary: it.query ?? "" }
          : it.type === "mcp_tool_call"
            ? { name: `${it.server ?? "mcp"}.${it.tool ?? ""}`, summary: "" }
            : it.type === "file_change"
              ? { name: "Edit", summary: (it.changes ?? []).map((c) => c.path).join(", ") }
              : null;
    if (tool) {
      this.items.push({ role: "tool", text: `${tool.name}(${tool.summary})` });
      this.emit({ type: "tool", id: it.id ?? String(Date.now()), name: tool.name, summary: tool.summary.slice(0, 140), sub: false });
    }
  };

  /** The project's memory (Hindsight, single-bank address) as a Codex MCP server, like Claude tabs get. */
  private mcpConfig(): string[] {
    const base = process.env.HINDSIGHT_MCP_URL || this.cfg.memory?.hindsight_mcp;
    if (!this.cfg.mcp?.hindsight || !base) return [];
    return [`mcp_servers.harness_memory.url="${bankMcpUrl(base, bankFor(this.cfg, this.cwd))}"`];
  }

  private async runTurn(prompt: string) {
    this.busy = true;
    this.emit({ type: "busy", busy: true });
    try {
      const status = codexStatus(this.cfg.root);
      if (!status.ok) throw new Error(`GPT unavailable: ${status.detail}`);
      if (!this.title) this.title = prompt.replace(/\s+/g, " ").slice(0, 60);
      this.items.push({ role: "user", text: prompt });
      // A new Codex thread gets the harness's notes (project context, lessons, memory) first.
      const notes = this.thread ? "" : gptPreamble(this.cfg, this.cwd);
      const full = `${notes}${this.pendingContext ? `${this.pendingContext}\n\n` : ""}${prompt}`;
      this.pendingContext = "";
      const run = runCodex({ root: this.cfg.root, model: this.model, prompt: full, cwd: this.cwd, resume: this.thread, fast: this.fast, config: this.mcpConfig(), onEvent: this.onCodexEvent });
      this.child = run.child;
      const r = await run.done;
      if (r.threadId) {
        this.thread = r.threadId;
        if (!this.sessionId) this.sessionId = r.threadId;
      }
      if (r.usage?.input_tokens) {
        this.lastInput = r.usage.input_tokens;
        const ctx = await this.context();
        if (ctx) this.emit({ type: "context", context: ctx });
      }
      this.save();
      const corrected = this.correction !== null; // stopped on purpose for a /change: not an error
      this.emit({ type: "turn-end", numTurns: 1, agents: [], costUsd: 0, isError: !r.ok && !corrected, error: r.ok || corrected ? undefined : r.error });
    } catch (err) {
      this.emit({ type: "error", message: (err as Error).message });
    } finally {
      this.child = null;
      this.busy = false;
      this.emit({ type: "busy", busy: false });
      const fix = this.correction;
      this.correction = null;
      if (fix !== null) void this.runTurn(`[The user corrected the task while you were working on it. Take this into account and carry on from where you stopped: ${fix}]`);
      else {
        const next = this.queue.shift();
        if (next) void this.runTurn(next);
      }
    }
  }
}

/** The first message of a forked GPT chat: the copied conversation, so a fresh Codex thread knows it. */
function forkSeed(items: HistoryItem[], title: string): string {
  const lines: string[] = [];
  let size = 0;
  for (const h of [...items].reverse()) {
    const line = `${h.role === "user" ? "User" : h.role === "assistant" ? "Assistant" : `(${h.role})`}: ${h.text.slice(0, h.role === "tool" ? 300 : 4000)}`;
    if (size + line.length > 60_000) break;
    lines.unshift(line);
    size += line.length;
  }
  return `[This chat is a copy ("fork") of "${title}". The conversation so far follows; carry on from it.]\n\n${lines.join("\n")}`;
}
