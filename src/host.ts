import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { HarnessConfig } from "./config.js";
import { Harness } from "./session.js";
import { ChatEngine, attachmentNote, expandShortcut, mentionNote, parseMentions, type ChatEvent, type ChatSummary, type Engine, type HistoryItem } from "./engine.js";
import { GptChat, listGptChats, isGptChat } from "./gpt-chat.js";
import type { Ask } from "./guards.js";
import { isExhausted, nearLimit, loadUsage, formatReset, type UsageSnapshot } from "./usage.js";
import { strongInstincts } from "./instincts.js";
import { loadContext } from "./project-context.js";
import { readCodexUsage } from "./codex-usage.js";
import { sendToCloud, returnFromCloud, loadCloudStates, saveCloudState, type CloudState } from "./cloud.js";

export interface TabInfo {
  id: string;
  windowId: number;
  kind: "claude" | "gpt";
  model: string;
  sessionId: string | null;
  title: string;
  busy: boolean;
  verify: boolean;
  /** GPT tabs: fast mode on (/fast). */
  fast?: boolean;
  /** Set while this tab's task runs in a Claude cloud session (/cloud). */
  cloud?: { branch: string; url?: string; inTerminal?: boolean; at: number } | null;
}

interface Tab {
  id: string;
  windowId: number;
  engine: Engine;
  harness: Harness;
  title: string;
  /** Set while the tab's task runs in a Claude cloud session. */
  cloud?: CloudState | null;
  /** Set while the tab is moving to GPT; messages sent meanwhile wait here. */
  switching?: { text: string; source: string; prompt: string }[];
}

export type HostListener = (msg: { type: "event"; tabId: string; event: ChatEvent } | { type: "tabs"; tabs: TabInfo[] }) => void;

const isGpt = (model: string) => /^gpt-/i.test(model);
let seq = 0;

/**
 * Owns every open tab. Each tab has its own engine and runs independently, so
 * several tasks can run at once. Events go to every listener: app windows and
 * terminals attached through the bridge.
 */
/**
 * What a GPT tab starts from when a Claude task moves over: as much of the
 * conversation as fits (newest kept, ~60k characters), plus the project's
 * pinned files and links and the strong lessons about how the user works,
 * since those were in Claude's instructions and GPT wouldn't otherwise see them.
 */
export function gptHandover(history: HistoryItem[], cwd: string, cfg: HarnessConfig, almost = false): string {
  const lines: string[] = [];
  let size = 0;
  for (const h of [...history].reverse()) {
    const who = h.role === "user" ? "User" : h.role === "assistant" ? "Assistant" : `(${h.role})`;
    const line = `${who}: ${h.text.slice(0, h.role === "tool" ? 400 : 4000)}`;
    if (size + line.length > 60_000) break;
    lines.unshift(line);
    size += line.length;
  }
  const parts = [`You are continuing a task that was running on Claude until its usage ${almost ? "was almost used up" : "limit was reached"}. Here is the conversation so far${lines.length < history.length ? " (the oldest part is left out)" : ""}:`, "", lines.join("\n") || "(no earlier messages)"];
  const ctx = loadContext(cfg, cwd);
  if (ctx.files.length || ctx.links.length) parts.push("", "Files and links the user pinned to this project (open what's relevant):", ...ctx.files.map((f) => `- ${f}`), ...ctx.links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`));
  const lessons = strongInstincts(cfg, cwd);
  if (lessons.length) parts.push("", "How this user wants work done (learned):", ...lessons.map((i) => `- ${i.trigger}: ${i.action}`));
  parts.push("", "Pick up where it left off. The user's latest request follows.");
  return parts.join("\n");
}

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

  /** When plan usage was last read on demand (ms). */
  usageReadAt = 0;

  /** Latest ChatGPT plan usage, read through Codex. */
  gptUsage: (UsageSnapshot & { plan?: string }) | null = null;

  /** Re-read Claude and ChatGPT plan usage now (not only when a message runs). */
  async refreshUsage(): Promise<UsageSnapshot | null> {
    const h = this.tabs.values().next().value?.harness ?? new Harness(this.cfg, this.askFor(0));
    const [snap, gpt] = await Promise.all([
      h.refreshUsage().catch(() => null),
      readCodexUsage(this.cfg.root, { warnAt: this.cfg.limits.warn_at }).catch(() => null),
    ]);
    if (gpt) this.gptUsage = gpt;
    this.usageReadAt = Date.now();
    if (snap && (!this.usage || snap.at >= this.usage.at)) this.usage = snap;
    return this.usage;
  }

  /** Claude is out of usage, or almost (limits.switch_at), so new work goes to GPT. */
  get claudeLimited() {
    return this.cfg.limits.fallback_to_gpt && (isExhausted(this.usage) || nearLimit(this.usage, this.cfg.limits.switch_at ?? 0.95));
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
      fast: t.engine.kind === "gpt" ? !!t.engine.fast : false,
      cloud: this.cloudOf(t) && { branch: this.cloudOf(t)!.branch, url: this.cloudOf(t)!.url, inTerminal: this.cloudOf(t)!.inTerminal, at: this.cloudOf(t)!.at },
    };
  }

  /** The cloud hand-off for this tab, also after a restart (saved by chat id). */
  private cloudOf(t: Tab): CloudState | null {
    if (t.cloud !== undefined) return t.cloud;
    const id = t.engine.sessionId;
    return id ? (loadCloudStates(this.cfg)[id] ?? null) : null;
  }

  /**
   * /cloud: stop the tab's task, write its hand-off, and send it to a Claude
   * cloud session (see cloud.ts). The tab then waits until you continue here.
   */
  async cloud(tabId: string): Promise<{ note: string; url?: string; branch: string }> {
    const t = this.get(tabId);
    if (this.cloudOf(t)) throw new Error("This tab's task is already in the cloud. Use Continue here (or /cloud back) first.");
    if (t.engine.busy) await t.engine.stop().catch(() => {});
    // Claude writes its hand-off on a throwaway fork; GPT writes its transcript. Either way the cloud gets a note.
    const h = t.engine instanceof ChatEngine ? await t.engine.handoff(false) : await (t.engine as GptChat).handoff();
    if (!h) throw new Error("Nothing to send yet: start the task here first, then /cloud.");
    const ask = this.askFor(t.windowId);
    const r = await sendToCloud(this.cfg, t.harness.cwd, t.title || "Continue the task", h.text, ask, async (repo) =>
      /^y/i.test((await ask(`⚠ Approve GitHub action?
${repo} is a public repository: anyone can read what's pushed. Include this project's memory (.cloud/memory.md, secrets removed)? Say no to send only the hand-off note. [y/N]`)).trim()),
    );
    const { note, ...state } = r;
    t.cloud = state;
    if (t.engine.sessionId) saveCloudState(this.cfg, t.engine.sessionId, state);
    this.publishTabs();
    return { note, url: state.url, branch: state.branch };
  }

  /** Bring a cloud task back: check out its branch here and continue in this tab from what it did. */
  async cloudBack(tabId: string): Promise<{ note: string }> {
    const t = this.get(tabId);
    const state = this.cloudOf(t);
    if (!state) throw new Error("This tab has nothing in the cloud.");
    const { summary, note } = await returnFromCloud(state, this.askFor(t.windowId));
    const oldId = t.engine.sessionId;
    // A fresh session in the same tab: the old chat may already be near its context limit.
    this.retarget(t, state.cwd, t.engine.model);
    t.engine.seed(summary);
    t.cloud = null;
    if (oldId) saveCloudState(this.cfg, oldId, null);
    t.title = `${t.title} (back from cloud)`;
    this.publishTabs();
    return { note };
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
  createTab(opts: { windowId: number; model?: string; chatId?: string; title?: string; cwd?: string }): TabInfo {
    const id = `t${++seq}`;
    const harness = new Harness(this.cfg, this.askFor(opts.windowId), opts.cwd ?? this.workspace);
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
  private async fallbackToGpt(tabId: string, prompt: string, almost = false, shown?: string) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    const resets = formatReset(this.usage?.resetsAt ?? this.usage?.windows.find((w) => w.resetsAt)?.resetsAt ?? null);
    const why = almost ? `Claude's usage is almost used up (${Math.round(Math.max(...(this.usage?.windows ?? []).map((w) => w.utilization ?? 0)) * 100)}%)` : "Claude's usage limit is reached";
    if (!this.cfg.limits.fallback_to_gpt) {
      this.note(tabId, `${why}${resets ? ` (resets ${resets})` : ""}. Pick a GPT model at the top to keep going.`);
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
      gpt.seed(gptHandover(history, t.harness.cwd, this.cfg, almost));
    } finally {
      const waiting = t.switching ?? [];
      t.switching = undefined;
      if (t.engine === gpt) {
        this.note(tabId, `${why}${resets ? ` (resets ${resets})` : ""}. Continuing this task on ${this.cfg.models.gpt[0]} with your ChatGPT plan, with the conversation so far.`);
        if (shown !== undefined) gpt.send(shown, "app", prompt);
        else gpt.send(prompt, "auto");
        for (const m of waiting) gpt.send(m.text, m.source, m.prompt);
      } else {
        for (const m of waiting) t.engine.send(m.text, m.source, m.prompt);
      }
    }
  }

  /** Write a hand-off summary (context.md) for this tab's chat now (Claude: on a fork; GPT: from the transcript). */
  async handoff(tabId: string) {
    const t = this.get(tabId);
    return t.engine instanceof ChatEngine ? t.engine.handoff(false) : (t.engine as GptChat).handoff();
  }

  /**
   * Open a new tab (same window, model and folder) that starts from a hand-off
   * summary: it goes in front of the first message you send there.
   */
  continueInNewChat(tabId: string, file: string): TabInfo {
    const t = this.get(tabId);
    const root = join(this.cfg.root, ".harness", "handoffs");
    const path = resolve(file);
    if (!path.startsWith(root + sep) || !existsSync(path)) throw new Error("That hand-off file isn't available any more.");
    const summary = readFileSync(path, "utf8");
    const info = this.createTab({ windowId: t.windowId, model: t.engine.model, cwd: t.harness.cwd, title: `${t.title} (continued)` });
    const next = this.get(info.id);
    next.engine.seed(
      `[This chat continues an earlier one ("${t.title}") whose context window filled up. Its hand-off summary follows; treat it as what you already know, and carry on from it.]\n\n${summary}`,
    );
    return info;
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

  /**
   * Send a message. `mentions` are MCP servers named with @ (the app resolves
   * them); without it, @names in the text are passed through as typed.
   */
  send(tabId: string, text: string, source = "app", mentions?: string[], files: string[] = []) {
    const t = this.get(tabId);
    // /fast: GPT tabs only (the Claude plan here doesn't offer fast mode).
    const fastCmd = text.trim().match(/^\/fast(?:\s+(on|off))?\s*$/i);
    if (fastCmd) {
      const note = (msg: string) => this.broadcast({ type: "event", tabId, event: { type: "note", text: msg } });
      if (t.engine.kind !== "gpt") return note("Fast mode isn't available on your Claude plan. It works in GPT tabs: switch this tab's model to a GPT one, then /fast.");
      t.engine.fast = fastCmd[1] ? fastCmd[1].toLowerCase() === "on" : !t.engine.fast;
      note(t.engine.fast ? `Fast mode on for ${t.engine.model}: about 2x speed, uses more of your ChatGPT plan. /fast again turns it off.` : "Fast mode off.");
      this.publishTabs();
      return;
    }
    // /cloud and /cloud back work the same from the app and a linked terminal.
    const cloudCmd = text.trim().match(/^\/cloud(?:\s+(back))?\s*$/i);
    if (cloudCmd) {
      const note = (msg: string) => this.broadcast({ type: "event", tabId, event: { type: "note", text: msg } });
      note(cloudCmd[1] ? "Bringing the cloud's work back…" : "Sending this task to a Claude cloud session: writing the hand-off, saving the work to a branch…");
      void (cloudCmd[1] ? this.cloudBack(tabId) : this.cloud(tabId))
        .then((r) => note("url" in r && r.url ? `${r.note} Follow it on your phone in the Claude app, or at ${r.url}` : r.note))
        .catch((err) => note(`/cloud: ${(err as Error).message}`));
      return;
    }
    if (this.cloudOf(t)) throw new Error("This tab's task is running in the cloud. Use Continue here (or /cloud back) to bring it back first, or open a new tab.");
    const [cmd, ...rest] = text.trim().split(/\s+/);
    // Attached files: only ones that exist, at most 20.
    const attached = files.filter((f) => typeof f === "string" && existsSync(f)).slice(0, 20);
    const base = expandShortcut(cmd, rest.join(" ")) ?? (text.trim() || (attached.length ? "Have a look at the attached file(s)." : text));
    const msg = attached.length ? `${base}\n\nAttached: ${attached.map((f) => f.split(/[\\/]/).pop()).join(", ")}` : base;
    const prompt = base + attachmentNote(attached) + mentionNote(mentions ?? parseMentions(text));
    if (t.switching) {
      t.switching.push({ text: msg, source, prompt });
      this.broadcast({ type: "event", tabId, event: { type: "user", text: msg, source, queued: true } });
      return;
    }
    // Claude is almost out: move this conversation to GPT before it runs, not after Claude refuses.
    if (t.engine.kind === "claude" && !t.engine.busy && this.cfg.limits.fallback_to_gpt && nearLimit(this.usage, this.cfg.limits.switch_at ?? 0.95)) {
      void this.fallbackToGpt(tabId, prompt, true, msg);
      return;
    }
    t.engine.send(msg, source, prompt);
  }

  stop(tabId: string) {
    return this.get(tabId).engine.stop();
  }

  btw(tabId: string, q: string) {
    return this.get(tabId).engine.btw(q);
  }

  /** Open a chat in a tab. A chat from another folder runs in that folder. */
  async openChat(tabId: string, chatId: string, title?: string, cwd?: string): Promise<HistoryItem[]> {
    const t = this.get(tabId);
    if (t.engine.busy) throw new Error("This tab is busy. Open the chat in a new tab, or stop this one first.");
    const wantGpt = isGptChat(this.cfg, chatId);
    const model = wantGpt ? this.cfg.models.gpt[0] : this.cfg.models.main;
    if (cwd && cwd !== t.harness.cwd) this.retarget(t, cwd, model);
    else if (wantGpt !== (t.engine.kind === "gpt")) t.engine = this.makeEngine(t, model);
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
      this.retarget(t, dir, t.engine.model);
      t.title = "New chat";
    }
    this.publishTabs();
  }

  /** Give an idle tab a fresh Harness and engine that work in `dir`. */
  private retarget(t: Tab, dir: string, model: string) {
    const harness = new Harness(this.cfg, this.askFor(t.windowId), dir);
    harness.verifyEnabled = t.harness.verifyEnabled;
    if (this.plan) harness.plan = this.plan;
    if (this.commands) harness.commands = this.commands;
    t.harness = harness;
    t.engine = this.makeEngine(t, model);
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

  /** Claude and GPT chats from every folder on this computer, newest first. */
  async chats(limit = 100): Promise<ChatSummary[]> {
    const claude = (await listSessions({ limit })).map((s) => ({
      id: s.sessionId,
      title: s.customTitle ?? s.summary,
      updated: s.lastModified,
      kind: "claude" as const,
      cwd: s.cwd,
    }));
    return [...claude, ...listGptChats(this.cfg)].sort((a, b) => b.updated - a.updated).slice(0, limit);
  }
}
