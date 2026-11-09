import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";
import { Harness } from "./session.js";
import { ChatEngine, expandShortcut, type ChatEvent, type ChatSummary, type Engine, type HistoryItem } from "./engine.js";
import { GptChat, listGptChats, isGptChat } from "./gpt-chat.js";
import type { Ask } from "./guards.js";

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

  constructor(
    readonly cfg: HarnessConfig,
    private askFor: (windowId: number) => Ask,
  ) {}

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
      this.broadcast({ type: "event", tabId: tab.id, event });
      if (event.type === "busy" || event.type === "session") this.publishTabs();
    };
    if (isGpt(model)) return new GptChat(this.cfg, model, emit);
    const engine = new ChatEngine(tab.harness, emit, { stream: true });
    if (model !== this.cfg.models.main) tab.harness.modelOverride = model;
    return engine;
  }

  /** Open a tab. With a chat id it resumes that chat (Claude or GPT). */
  createTab(opts: { windowId: number; model?: string; chatId?: string; title?: string }): TabInfo {
    const id = `t${++seq}`;
    const harness = new Harness(this.cfg, this.askFor(opts.windowId));
    if (this.plan) harness.plan = this.plan;
    if (this.commands) harness.commands = this.commands;
    const gptChat = opts.chatId ? isGptChat(this.cfg, opts.chatId) : false;
    const model = opts.model ?? (gptChat ? this.cfg.models.gpt[0] : this.cfg.models.main);
    const partial = { id, harness };
    const engine = this.makeEngine(partial, model);
    const tab: Tab = { id, windowId: opts.windowId, engine, harness, title: opts.title ?? "New chat" };
    this.tabs.set(id, tab);
    if (opts.chatId) engine.resume(opts.chatId);
    this.activeTab = id;
    this.publishTabs();
    return this.info(tab);
  }

  async closeTab(tabId: string) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    if (t.engine.busy) await t.engine.stop();
    this.tabs.delete(tabId);
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
    t.engine.send(expandShortcut(cmd, rest.join(" ")) ?? text, source);
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
    const claude = (await listSessions({ dir: process.cwd(), limit })).map((s) => ({
      id: s.sessionId,
      title: s.customTitle ?? s.summary,
      updated: s.lastModified,
      kind: "claude" as const,
    }));
    return [...claude, ...listGptChats(this.cfg, process.cwd())].sort((a, b) => b.updated - a.updated).slice(0, limit);
  }
}
