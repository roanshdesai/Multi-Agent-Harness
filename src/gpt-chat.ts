import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HarnessConfig } from "./config.js";
import { runCodex, type CodexEvent } from "./codex.js";
import { codexStatus } from "./subscription.js";
import type { ChatEvent, ChatSummary, Engine, HistoryItem } from "./engine.js";

interface StoredGptChat {
  id: string;
  title: string;
  model: string;
  cwd: string;
  updated: number;
  items: HistoryItem[];
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

  constructor(
    private cfg: HarnessConfig,
    public model: string,
    private emit: (e: ChatEvent) => void,
    readonly cwd = process.cwd(),
  ) {}

  private file(id: string) {
    return join(dirFor(this.cfg), `${id}.json`);
  }

  private save() {
    if (!this.sessionId) return;
    mkdirSync(dirFor(this.cfg), { recursive: true });
    const data: StoredGptChat = { id: this.sessionId, title: this.title, model: this.model, cwd: this.cwd, updated: Date.now(), items: this.items };
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
    this.items = [];
    this.title = "";
  }

  resume(id: string) {
    const c = JSON.parse(readFileSync(this.file(id), "utf8")) as StoredGptChat;
    this.sessionId = c.id;
    this.items = c.items;
    this.title = c.title;
    this.model = c.model;
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

  async fork(): Promise<string> {
    throw new Error("Forking isn't available for GPT chats yet.");
  }

  /** Codex can't take input mid-turn, so a correction runs right after the current turn. */
  change(text: string, source?: string) {
    if (this.busy) this.emit({ type: "note", text: "GPT can't take corrections mid-turn; this runs as soon as the current turn ends." });
    this.send(text, source);
  }

  async context() {
    return null;
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
    if (e.type === "thread.started" && e.thread_id && !this.sessionId) {
      this.sessionId = e.thread_id;
      this.emit({ type: "session", id: e.thread_id });
    }
    const it = e.item;
    if (!it) return;
    if (e.type === "item.completed" && it.type === "agent_message" && it.text) {
      this.items.push({ role: "assistant", text: it.text });
      this.emit({ type: "text", text: it.text });
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

  private async runTurn(prompt: string) {
    this.busy = true;
    this.emit({ type: "busy", busy: true });
    try {
      const status = codexStatus(this.cfg.root);
      if (!status.ok) throw new Error(`GPT unavailable: ${status.detail}`);
      if (!this.title) this.title = prompt.replace(/\s+/g, " ").slice(0, 60);
      this.items.push({ role: "user", text: prompt });
      const full = this.pendingContext ? `${this.pendingContext}\n\n${prompt}` : prompt;
      this.pendingContext = "";
      const run = runCodex({ root: this.cfg.root, model: this.model, prompt: full, cwd: this.cwd, resume: this.sessionId, onEvent: this.onCodexEvent });
      this.child = run.child;
      const r = await run.done;
      if (r.threadId && !this.sessionId) this.sessionId = r.threadId;
      this.save();
      this.emit({ type: "turn-end", numTurns: 1, agents: [], costUsd: 0, isError: !r.ok, error: r.ok ? undefined : r.error });
    } catch (err) {
      this.emit({ type: "error", message: (err as Error).message });
    } finally {
      this.child = null;
      this.busy = false;
      this.emit({ type: "busy", busy: false });
      const next = this.queue.shift();
      if (next) void this.runTurn(next);
    }
  }
}
