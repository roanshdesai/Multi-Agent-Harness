import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  forkSession,
  listSessions,
  renameSession,
  getSessionMessages,
  type Options,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Harness, type TurnResult, type AgentQuestion, type ContextInfo } from "./session.js";
import type { UsageSnapshot } from "./usage.js";

/** Everything a UI (terminal or desktop) needs to draw a chat. */
export type ChatEvent =
  | { type: "session"; id: string }
  | { type: "busy"; busy: boolean }
  | { type: "user"; text: string; queued?: boolean; source?: string; change?: boolean }
  | { type: "context"; context: ContextInfo }
  | { type: "text-delta"; text: string }
  | { type: "text"; text: string }
  | { type: "agent"; id: string; agent: string; description: string }
  | { type: "tool"; id: string; name: string; summary: string; sub: boolean }
  | { type: "verify"; status: "running" | "pass" | "fail"; round: number; feedback?: string }
  | { type: "turn-end"; numTurns: number; agents: string[]; costUsd: number; isError: boolean; error?: string }
  | { type: "error"; message: string }
  | { type: "note"; text: string }
  | { type: "question"; id: string; questions: AgentQuestion[] }
  | { type: "question-answered"; id: string; answers: Record<string, string> }
  | { type: "advisor"; status: "asked" | "answered" }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "limit"; prompt: string; resetsAt: number | null };

export interface HistoryItem {
  role: "user" | "assistant" | "agent" | "tool";
  text: string;
  /** A /change correction sent while the agent worked. */
  change?: boolean;
}

/** Messages Claude Code adds to the transcript itself (not typed by you). */
const INTERNAL = /^\s*<(task-notification|system-reminder|local-command-[a-z]+|command-name|command-message|command-args|bash-[a-z]+)>/;
const CHANGE_PREFIX = "[Correction from the user while you work: keep going, just adjust] ";

function userItem(text: string): HistoryItem | null {
  if (!text.trim() || INTERNAL.test(text)) return null;
  if (text.startsWith(CHANGE_PREFIX)) return { role: "user", text: text.slice(CHANGE_PREFIX.length), change: true };
  return { role: "user", text };
}

export interface ChatSummary {
  id: string;
  title: string;
  updated: number;
  kind?: "claude" | "gpt";
  model?: string;
}

/** What every chat engine (Claude or GPT) offers to the apps. */
export interface Engine {
  readonly kind: "claude" | "gpt";
  model: string;
  sessionId?: string;
  busy: boolean;
  send(text: string, source?: string): void;
  stop(): Promise<void>;
  newChat(): void;
  resume(id: string): void;
  history(id: string): Promise<HistoryItem[]>;
  btw(question: string): Promise<string>;
  fork(title?: string): Promise<string>;
  rename(title: string): Promise<void>;
  /** Answer a question the agent asked (from the app or a linked terminal). */
  answer(id: string, answers: Record<string, string>): boolean;
  /** /change: correct the running task without stopping it. Sent normally when idle. */
  change(text: string, source?: string): void;
  /** Tokens in the context window, by category. */
  context(): Promise<ContextInfo | null>;
}

/** How a /change correction is phrased to the model. */
export const changeNote = (text: string) => `${CHANGE_PREFIX}${text}`;

export function summarizeInput(input: any): string {
  const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.prompt ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 140);
}

/** Slash commands that just turn into a prompt for a specific specialist. */
export function expandShortcut(cmd: string, arg: string): string | null {
  switch (cmd) {
    case "/advisor":
      return `Consult the "advisor" agent on this and report its recommendation: ${arg}`;
    case "/code":
      return `Delegate this coding task to the "coder" agent, verify it, and report back: ${arg}`;
    case "/research":
      return `Use "researcher" agents (in parallel if it splits) to research: ${arg}`;
    case "/test":
      return `Have the "gui-tester" agent test this: ${arg}`;
    case "/video":
      return `Delegate to the "video" agent: ${arg}`;
    case "/image":
      return `Delegate to the "image" agent (GPT-6.1 Sol): ${arg}`;
    case "/remember":
      return `Store this in long-term memory (Hindsight retain), confirm briefly: ${arg}`;
    case "/recall":
      return `Search long-term memory (Hindsight recall/reflect, and claude-mem if available) for: ${arg}`;
    default:
      return null;
  }
}

/**
 * One chat: runs turns (with the verifier loop), queues input while busy,
 * answers /btw on a throwaway fork, and forks/resumes sessions.
 */
export class ChatEngine implements Engine {
  readonly kind = "claude" as const;
  sessionId?: string;
  busy = false;
  private current: Query | null = null;
  private stopped = false;
  private questions = new Map<string, (a: Record<string, string>) => void>();
  private steer: ((text: string) => boolean) | null = null;
  lastContext: ContextInfo | null = null;
  private qseq = 0;
  private queue: string[] = [];
  private stateFile: string;

  constructor(
    readonly harness: Harness,
    private emit: (e: ChatEvent) => void,
    private opts: { stream?: boolean; cwd?: string } = {},
  ) {
    this.stateFile = join(harness.cfg.root, ".harness", "last-session");
    // The agent can ask you things; whichever app answers first wins.
    harness.onQuestion = (questions) =>
      new Promise((resolve) => {
        const id = `q${++this.qseq}`;
        this.questions.set(id, resolve);
        this.emit({ type: "question", id, questions });
      });
    harness.onUsage = (usage) => this.emit({ type: "usage", usage });
  }

  change(text: string, source?: string) {
    if (this.busy && this.steer?.(changeNote(text))) {
      this.emit({ type: "user", text, source, change: true });
      return;
    }
    this.send(text, source);
  }

  async context(): Promise<ContextInfo | null> {
    if (this.lastContext || !this.sessionId) return this.lastContext;
    this.lastContext = await this.harness.contextFor(this.sessionId);
    return this.lastContext;
  }

  answer(id: string, answers: Record<string, string>): boolean {
    const resolve = this.questions.get(id);
    if (!resolve) return false;
    this.questions.delete(id);
    resolve(answers);
    this.emit({ type: "question-answered", id, answers });
    return true;
  }

  get cwd() {
    return this.opts.cwd ?? process.cwd();
  }

  get model() {
    return this.harness.mainModel;
  }
  set model(m: string) {
    this.harness.modelOverride = m;
  }

  /** Send user input; queued if a turn is already running. `source` says which app typed it. */
  send(text: string, source?: string) {
    this.emit({ type: "user", text, queued: this.busy, source });
    if (this.busy) {
      this.queue.push(text);
      return;
    }
    void this.runTurn(text);
  }

  async stop() {
    this.stopped = true;
    this.queue.length = 0;
    for (const id of [...this.questions.keys()]) this.answer(id, {});
    if (this.current) await this.current.interrupt();
  }

  newChat() {
    this.sessionId = undefined;
  }

  resume(id: string) {
    this.sessionId = id;
    this.lastContext = null;
    this.emit({ type: "session", id });
  }

  lastSession(): string | undefined {
    return existsSync(this.stateFile) ? readFileSync(this.stateFile, "utf8").trim() || undefined : undefined;
  }

  async fork(title?: string): Promise<string> {
    if (!this.sessionId) throw new Error("Nothing to fork yet; send a message first.");
    const { sessionId } = await forkSession(this.sessionId, { title });
    return sessionId;
  }

  async rename(title: string) {
    if (this.sessionId) await renameSession(this.sessionId, title);
  }

  async listChats(limit = 50): Promise<ChatSummary[]> {
    const list = await listSessions({ dir: this.cwd, limit });
    return list.map((s) => ({ id: s.sessionId, title: s.customTitle ?? s.summary, updated: s.lastModified }));
  }

  /** Readable transcript of a saved chat (main thread only, subagent internals collapsed). */
  async history(id: string): Promise<HistoryItem[]> {
    const msgs = await getSessionMessages(id, { dir: this.cwd });
    const out: HistoryItem[] = [];
    for (const m of msgs) {
      if (m.parent_tool_use_id) continue;
      const content = (m.message as any)?.content;
      if (m.type === "user") {
        const t = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
        const item = userItem(t);
        if (item) out.push(item);
      } else if (m.type === "assistant" && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "text" && b.text.trim()) out.push({ role: "assistant", text: b.text });
          else if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task"))
            out.push({ role: "agent", text: `${b.input?.subagent_type ?? "agent"}: ${b.input?.description ?? ""}` });
          else if (b.type === "tool_use") out.push({ role: "tool", text: `${b.name}(${summarizeInput(b.input)})` });
        }
      }
    }
    return out;
  }

  /** /btw: side question on a throwaway fork. Safe to call while a turn runs. */
  async btw(question: string): Promise<string> {
    const opts: Partial<Options> = {
      persistSession: false,
      maxTurns: 6,
      disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash", "Agent", "mcp__github__*", "mcp__slack__*", "mcp__outlook__*"],
      ...(this.sessionId ? { resume: this.sessionId, forkSession: true } : {}),
    };
    const r = await this.harness.run(
      `(Side question from the user. Answer briefly from what you already know; do not start or change any work.)\n\n${question}`,
      opts,
    );
    return r.text;
  }

  private onMessage = (m: SDKMessage) => {
    if (m.type === "system" && m.subtype === "init") {
      if (m.session_id !== this.sessionId) {
        this.sessionId = m.session_id;
        this.emit({ type: "session", id: m.session_id });
      }
      return;
    }
    if (m.type === "stream_event") {
      const ev = m.event as any;
      if (!m.parent_tool_use_id && ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.emit({ type: "text-delta", text: ev.delta.text });
      }
      return;
    }
    if (m.type !== "assistant") return;
    const sub = m.parent_tool_use_id !== null;
    for (const b of m.message.content as { type: string; name?: string }[]) {
      if (b.type === "server_tool_use" && b.name === "advisor") this.emit({ type: "advisor", status: "asked" });
      if (b.type === "advisor_tool_result") this.emit({ type: "advisor", status: "answered" });
    }
    for (const b of m.message.content) {
      if (b.type === "text" && !sub && b.text.trim()) this.emit({ type: "text", text: b.text });
      else if (b.type === "tool_use") {
        const input = b.input as any;
        if (b.name === "Agent" || b.name === "Task")
          this.emit({ type: "agent", id: b.id, agent: input?.subagent_type ?? "agent", description: String(input?.description ?? "") });
        else this.emit({ type: "tool", id: b.id, name: b.name, summary: summarizeInput(input), sub });
      }
    }
  };

  private async runTurn(prompt: string) {
    this.busy = true;
    this.stopped = false;
    this.emit({ type: "busy", busy: true });
    const h = this.harness;
    const extra: Partial<Options> = this.opts.stream ? { includePartialMessages: true } : {};
    const hooks = {
      onMessage: this.onMessage,
      onQuery: (q: Query) => (this.current = q),
      onSteer: (fn: (text: string) => boolean) => (this.steer = fn),
      onContext: (c: ContextInfo) => {
        this.lastContext = c;
        this.emit({ type: "context", context: c });
      },
    };
    try {
      let r: TurnResult = await h.run(prompt, { ...extra, ...(this.sessionId ? { resume: this.sessionId } : {}) }, hooks);
      this.sessionId = r.sessionId || this.sessionId;

      // Verify substantive work (anything delegated or multi-step).
      if (h.verifyEnabled && !r.isError && (r.agentsUsed.length > 0 || r.numTurns > 2) && this.sessionId && !prompt.startsWith("/")) {
        for (let round = 1; round <= h.cfg.verify.max_rounds; round++) {
          this.emit({ type: "verify", status: "running", round });
          this.steer = null; // corrections during verification wait for the next turn
          const v = await h.verify(this.sessionId, { onQuery: hooks.onQuery });
          if (this.stopped) break;
          this.emit({ type: "verify", status: v.pass ? "pass" : "fail", round, feedback: v.feedback });
          if (v.pass) break;
          r = await h.run(
            `An independent verifier reviewed your last answer and found problems:\n\n${v.feedback}\n\nFix them (delegate as usual), then give the corrected final answer.`,
            { ...extra, resume: this.sessionId },
            hooks,
          );
        }
      }
      if (r.rateLimited) {
        // Out of Claude usage: the host continues this on GPT if allowed.
        this.queue.length = 0;
        this.emit({ type: "limit", prompt, resetsAt: h.usage?.resetsAt ?? null });
      }
      this.emit({
        type: "turn-end",
        numTurns: r.numTurns,
        agents: [...new Set(r.agentsUsed)],
        costUsd: r.costUsd,
        isError: r.isError,
        error: r.isError ? r.text : undefined,
      });
    } catch (err) {
      this.emit({ type: "error", message: (err as Error).message });
    } finally {
      if (this.sessionId) writeFileSync(this.stateFile, this.sessionId);
      this.current = null;
      this.steer = null;
      this.busy = false;
      this.emit({ type: "busy", busy: false });
      const next = this.queue.shift();
      if (next) void this.runTurn(next);
    }
  }
}
