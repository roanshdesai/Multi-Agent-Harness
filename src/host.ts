import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";
import { Harness } from "./session.js";
import { ChatEngine, expandShortcut, type ChatEvent, type ChatSummary, type Engine, type HistoryItem } from "./engine.js";
import { GptChat, listGptChats, isGptChat } from "./gpt-chat.js";
import type { Ask } from "./guards.js";
import { isExhausted, loadUsage, formatReset, type UsageSnapshot } from "./usage.js";

export interface TabInfo {
  id: string;
  windowId: number;
  kind: "claude" | "gpt";
  model: string;
  sessionId: string | null;
  title: string;
  busy: boolean;
  verify: boolean;
}

interface Tab {
  id: string;
  windowId: number;
  engine: Engine;
  harness: Harness;
  title: string;
  /** Set while the tab is moving to GPT; messages sent meanwhile wait here. */
  switching?: { text: string; source: string }[];
}

export type HostListener = (msg: { type: "event"; tabId: string; event: ChatEvent } | { type: "tabs"; tabs: TabInfo[] }) => void;

const isGpt = (model: string) => /^gpt-/i.test(model);
let seq = 0;

/**
 * Owns every open tab. Each tab has its own engine and runs independently, so
 * several tasks can run at once. Events go to every listener: app windows and
 * terminals attached through the bridge.
 */
export class Host {
  private tabs = new Map<string, Tab>();
  private listeners = new Set<HostListener>();
  /** Most recently focused tab; a terminal attaches to it by default. */
  activeTab: string | null = null;
  plan?: string;
  commands?: Harness["commands"];
  /** Latest Claude usage seen by any tab. */
  usage: UsageSnapshot | null;
  /** Folder new tabs (and idle tabs after a change) work in. */
  workspace = process.cwd();
  /** Files the agents read or edited this session (for the Documents pane). */
  touched = new Map<string, "read" | "edited">();

  constructor(
    readonly cfg: HarnessConfig,
    private askFor: (windowId: number) => Ask,
  ) {
    this.usage = loadUsage(cfg);
  }

  /** Claude is out of usage right now (so new work goes to GPT). */
  get claudeLimited() {
    return this.cfg.limits.fallback_to_gpt && isExhausted(this.usage);
  }

  listen(fn: HostListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: Parameters<HostListener>[0]) {
    for (const l of this.listeners) l(msg);
  }

  private publishTabs() {
    this.broadcast({ type: "tabs", tabs: this.list() });
  }

  info(t: Tab): TabInfo {
    return {
      id: t.id,
      windowId: t.windowId,
      kind: t.engine.kind,
      model: t.engine.model,
      sessionId: t.engine.sessionId ?? null,
      title: t.title,
      busy: t.engine.busy,
      verify: t.harness.verifyEnabled,
    };
  }

  list(windowId?: number): TabInfo[] {
    return [...this.tabs.values()].filter((t) => windowId === undefined || t.windowId === windowId).map((t) => this.info(t));
  }

  get(tabId: string): Tab {
    const t = this.tabs.get(tabId);
    if (!t) throw new Error(`No such tab: ${tabId}`);
    return t;
  }

  private makeEngine(tab: Pick<Tab, "id" | "harness">, model: string): Engine {
    const emit = (event: ChatEvent) => {
      const t = this.tabs.get(tab.id);
      if (t && event.type === "user" && t.title === "New chat") t.title = event.text.replace(/\s+/g, " ").slice(0, 48);
      if (event.type === "usage") this.usage = event.usage;
      if (event.type === "tool" && /^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(event.name) && /[\\/]/.test(event.summary)) {
        const edited = event.name !== "Read";
        if (edited || !this.touched.has(event.summary)) this.touched.set(event.summary, edited ? "edited" : "read");
      }
      this.broadcast({ type: "event", tabId: tab.id, event });
      if (event.type === "limit") void this.fallbackToGpt(tab.id, event.prompt);
      if (event.type === "busy" || event.type === "session") this.publishTabs();
    };
    if (isGpt(model)) return new GptChat(this.cfg, model, emit, tab.harness.cwd);
    const engine = new ChatEngine(tab.harness, emit, { stream: true, cwd: tab.harness.cwd });
    if (model !== this.cfg.models.main) tab.harness.modelOverride = model;
    return engine;
  }

  /** Open a tab. With a chat id it resumes that chat (Claude or GPT). */
  createTab(opts: { windowId: number; model?: string; chatId?: string; title?: string }): TabInfo {
    const id = `t${++seq}`;
    const harness = new Harness(this.cfg, this.askFor(opts.windowId), this.workspace);
    if (this.plan) harness.plan = this.plan;
    if (this.commands) harness.commands = this.commands;
    const gptChat = opts.chatId ? isGptChat(this.cfg, opts.chatId) : false;
    const model = opts.model ?? (gptChat || this.claudeLimited ? this.cfg.models.gpt[0] : this.cfg.models.main);
    const partial = { id, harness };
    const engine = this.makeEngine(partial, model);
    const tab: Tab = { id, windowId: opts.windowId, engine, harness, title: opts.title ?? "New chat" };
    this.tabs.set(id, tab);
    if (opts.chatId) engine.resume(opts.chatId);
    this.activeTab = id;
    this.publishTabs();
    return this.info(tab);
  }

  private note(tabId: string, text: string) {
    this.broadcast({ type: "event", tabId, event: { type: "note", text } });
  }

  /**
   * Claude's usage limit was hit mid-task: carry the conversation over to GPT
   * in the same tab and re-send the request there.
   */
  private async fallbackToGpt(tabId: string, prompt: string) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    const resets = formatReset(this.usage?.resetsAt ?? null);
    if (!this.cfg.limits.fallback_to_gpt) {
      this.note(tabId, `Claude's usage limit is reached${resets ? ` (resets ${resets})` : ""}. Pick a GPT model at the top to keep going.`);
      return;
    }
    // Swap the engine before any await, so a message sent while the history
    // loads goes to GPT (queued until it is seeded), not back to Claude.
    const claude = t.engine;
    const gpt = this.makeEngine(t, this.cfg.models.gpt[0]) as GptChat;
    t.engine = gpt;
    t.switching = [];
    this.publishTabs();
    try {
      const sid = claude.sessionId;
      const history = sid ? await claude.history(sid).catch(() => []) : [];
      const transcript = history
        .slice(-30)
        .map((h) => `${h.role === "user" ? "User" : h.role === "assistant" ? "Assistant" : `(${h.role})`}: ${h.text.slice(0, 1500)}`)
        .join("\n");
      gpt.seed(
        `You are continuing a task that was running on Claude until its usage limit was reached. Here is the conversation so far:\n\n${transcript || "(no earlier messages)"}\n\nPick up where it left off. The user's latest request follows.`,
      );
    } finally {
      const waiting = t.switching ?? [];
      t.switching = undefined;
      if (t.engine === gpt) {
        this.note(tabId, `Claude's usage limit is reached${resets ? ` (resets ${resets})` : ""}. Continuing this task on ${this.cfg.models.gpt[0]} with your ChatGPT plan.`);
        gpt.send(prompt, "auto");
        for (const m of waiting) gpt.send(m.text, m.source);
      } else {
        for (const m of waiting) t.engine.send(m.text, m.source);
      }
    }
  }

  change(tabId: string, text: string, source = "app") {
    if (this.get(tabId).switching) return this.send(tabId, text, source);
    this.get(tabId).engine.change(text, source);
  }

  context(tabId: string) {
    return this.get(tabId).engine.context();
  }

  answer(tabId: string, id: string, answers: Record<string, string>) {
    return this.get(tabId).engine.answer(id, answers);
  }

  async connections(reconnect?: string) {
    const h = this.tabs.values().next().value?.harness ?? new Harness(this.cfg, this.askFor(0));
    return h.connections(reconnect);
  }

  async closeTab(tabId: string) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.tabs.delete(tabId); // close even if stopping fails
    if (t.engine.busy) await t.engine.stop().catch(() => {});
    if (this.activeTab === tabId) this.activeTab = [...this.tabs.keys()].pop() ?? null;
    this.publishTabs();
  }

  closeWindow(windowId: number) {
    for (const t of [...this.tabs.values()]) if (t.windowId === windowId) void this.closeTab(t.id);
  }

  focus(tabId: string) {
    if (this.tabs.has(tabId)) this.activeTab = tabId;
  }

  send(tabId: string, text: string, source = "app") {
    const t = this.get(tabId);
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const msg = expandShortcut(cmd, rest.join(" ")) ?? text;
    if (t.switching) {
      t.switching.push({ text: msg, source });
      this.broadcast({ type: "event", tabId, event: { type: "user", text: msg, source, queued: true } });
      return;
    }
    t.engine.send(msg, source);
  }

  stop(tabId: string) {
    return this.get(tabId).engine.stop();
  }

  btw(tabId: string, q: string) {
    return this.get(tabId).engine.btw(q);
  }

  async openChat(tabId: string, chatId: string, title?: string): Promise<HistoryItem[]> {
    const t = this.get(tabId);
    if (t.engine.busy) throw new Error("This tab is busy. Open the chat in a new tab, or stop this one first.");
    const wantGpt = isGptChat(this.cfg, chatId);
    if (wantGpt !== (t.engine.kind === "gpt")) t.engine = this.makeEngine(t, wantGpt ? this.cfg.models.gpt[0] : this.cfg.models.main);
    t.engine.resume(chatId);
    if (title) t.title = title;
    this.publishTabs();
    return t.engine.history(chatId);
  }

  async history(tabId: string): Promise<HistoryItem[]> {
    const t = this.get(tabId);
    return t.engine.sessionId ? t.engine.history(t.engine.sessionId) : [];
  }

  newChat(tabId: string) {
    const t = this.get(tabId);
    t.engine.newChat();
    t.title = "New chat";
    this.publishTabs();
  }

  /**
   * Change a tab's model. Same family: switch in place. Claude ↔ GPT on a tab
   * that already has a conversation: open a new tab, since the two can't share history.
   */
  setModel(tabId: string, model: string): { tabId: string; newTab: boolean } {
    const t = this.get(tabId);
    if (isGpt(model) === (t.engine.kind === "gpt")) {
      t.engine.model = model;
      this.publishTabs();
      return { tabId, newTab: false };
    }
    if (!t.engine.sessionId && !t.engine.busy) {
      t.engine = this.makeEngine(t, model);
      this.publishTabs();
      return { tabId, newTab: false };
    }
    const info = this.createTab({ windowId: t.windowId, model });
    return { tabId: info.id, newTab: true };
  }

  /**
   * Point the app at a new folder. Idle tabs move to it with a fresh chat (new
   * Harness and engine, so GPT tabs pick it up too). Busy tabs keep their folder
   * until they are closed, so a running task never changes folder mid-way.
   */
  setWorkspace(dir: string) {
    this.workspace = dir;
    for (const t of this.tabs.values()) {
      if (t.engine.busy || t.harness.cwd === dir) continue;
      const harness = new Harness(this.cfg, this.askFor(t.windowId), dir);
      harness.verifyEnabled = t.harness.verifyEnabled;
      if (this.plan) harness.plan = this.plan;
      if (this.commands) harness.commands = this.commands;
      t.harness = harness;
      t.engine = this.makeEngine(t, t.engine.model);
      t.title = "New chat";
    }
    this.publishTabs();
  }

  setVerify(tabId: string, on: boolean) {
    this.get(tabId).harness.verifyEnabled = on;
    this.publishTabs();
    return on;
  }

  rename(tabId: string, title: string) {
    const t = this.get(tabId);
    t.title = title;
    this.publishTabs();
    return t.engine.rename(title);
  }

  fork(tabId: string, title?: string) {
    return this.get(tabId).engine.fork(title);
  }

  harnessFor(tabId: string) {
    return this.get(tabId).harness;
  }

  /** Claude and GPT chats for the current folder, newest first. */
  async chats(limit = 100): Promise<ChatSummary[]> {
    const claude = (await listSessions({ dir: this.workspace, limit })).map((s) => ({
      id: s.sessionId,
      title: s.customTitle ?? s.summary,
      updated: s.lastModified,
      kind: "claude" as const,
    }));
    return [...claude, ...listGptChats(this.cfg, this.workspace)].sort((a, b) => b.updated - a.updated).slice(0, limit);
  }
}
