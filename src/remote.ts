import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "./config.js";
import type { Host } from "./host.js";
import type { ChatEvent } from "./engine.js";

/**
 * /remote: control the harness from another app (e.g. Pally) through MCP.
 *
 * A small MCP server (Streamable HTTP, JSON responses) on 127.0.0.1. The
 * secret token is part of the URL, so any MCP client that takes a URL can
 * connect. Off by default. Optionally published through a Cloudflare quick
 * tunnel when `cloudflared` is installed, so cloud apps can reach it.
 *
 * Remote callers can send messages, read replies, answer the agent's
 * questions and stop work. GitHub push approvals are never answered remotely.
 */

interface RemoteState {
  enabled: boolean;
  token: string;
}

interface TabLog {
  /** Latest finished reply text. */
  reply: string;
  /** Agent questions still waiting: id → questions. */
  questions: Map<string, unknown>;
  /** Short log of recent activity for status reads. */
  recent: string[];
}

const PROTOCOL = "2025-06-18";

export class RemoteControl {
  private server: Server | null = null;
  private tunnel: ChildProcess | null = null;
  publicUrl: string | null = null;
  tunnelError: string | null = null;
  private logs = new Map<string, TabLog>();
  private unlisten: (() => void) | null = null;
  private state: RemoteState;
  private file: string;

  constructor(
    private cfg: HarnessConfig,
    private host: Host,
  ) {
    this.file = join(cfg.root, ".harness", "remote.json");
    this.state = { enabled: false, token: "" };
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {
      /* first run */
    }
    if (!this.state.token) this.state.token = newToken();
  }

  get port() {
    return this.cfg.remote?.port ?? 0;
  }
  get enabled() {
    return !!this.server;
  }
  /** The local MCP URL, secret included. */
  get localUrl() {
    const addr = this.server?.address();
    const port = addr && typeof addr === "object" ? addr.port : this.port;
    return `http://127.0.0.1:${port}/mcp/${this.state.token}`;
  }
  get remoteUrl() {
    return this.publicUrl ? `${this.publicUrl}/mcp/${this.state.token}` : null;
  }

  status() {
    return {
      enabled: this.enabled,
      localUrl: this.enabled ? this.localUrl : null,
      publicUrl: this.enabled ? this.remoteUrl : null,
      tunnel: this.tunnel ? (this.publicUrl ? "up" : "starting") : cloudflaredAvailable() ? "off" : "not-installed",
      tunnelError: this.tunnelError,
    };
  }

  private save() {
    mkdirSync(join(this.cfg.root, ".harness"), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  /** Start if it was on last time. */
  async restore() {
    if (this.state.enabled) await this.start().catch(() => undefined);
  }

  async start(): Promise<ReturnType<RemoteControl["status"]>> {
    if (!this.server) {
      this.watch();
      this.server = createServer((req, res) => void this.handle(req, res));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, "127.0.0.1", () => resolve());
      });
    }
    this.state.enabled = true;
    this.save();
    return this.status();
  }

  async stop() {
    this.stopTunnel();
    this.unlisten?.();
    this.unlisten = null;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.state.enabled = false;
    this.save();
    return this.status();
  }

  /** New secret: every old link stops working. */
  rotate() {
    this.state.token = newToken();
    this.save();
    return this.status();
  }

  /** Publish through a Cloudflare quick tunnel (needs `cloudflared`). Resolves once the public URL is known. */
  startTunnel(timeoutMs = 30000): Promise<ReturnType<RemoteControl["status"]>> {
    if (!this.server) return Promise.resolve(this.status());
    if (this.tunnel) return Promise.resolve(this.status());
    this.tunnelError = null;
    if (!cloudflaredAvailable()) {
      this.tunnelError = "cloudflared isn't installed (on a Mac: brew install cloudflared).";
      return Promise.resolve(this.status());
    }
    const addr = this.server.address();
    const port = addr && typeof addr === "object" ? addr.port : this.port;
    return new Promise((resolve) => {
      const child = spawn(cloudflaredBin()!, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
      this.tunnel = child;
      let out = "";
      const done = () => {
        clearTimeout(t);
        resolve(this.status());
      };
      const t = setTimeout(() => {
        if (!this.publicUrl) this.tunnelError = "The tunnel didn't report a public address in time.";
        done();
      }, timeoutMs);
      const onData = (d: Buffer) => {
        out = (out + d.toString()).slice(-4000);
        const m = out.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !this.publicUrl) {
          this.publicUrl = m[0];
          done();
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.on("exit", () => {
        this.tunnel = null;
        this.publicUrl = null;
        if (!this.tunnelError) this.tunnelError = "The tunnel stopped.";
        done();
      });
    });
  }

  stopTunnel() {
    this.tunnel?.kill();
    this.tunnel = null;
    this.publicUrl = null;
    return this.status();
  }

  // ── activity per tab, so remote callers can read replies and questions ──
  private watch() {
    if (this.unlisten) return;
    this.unlisten = this.host.listen((m) => {
      if (m.type !== "event") return;
      const log = this.log(m.tabId);
      const e: ChatEvent = m.event;
      if (e.type === "text") log.reply = e.text;
      if (e.type === "user" && !e.queued) log.reply = "";
      if (e.type === "question") log.questions.set(e.id, e.questions);
      if (e.type === "question-answered") log.questions.delete(e.id);
      const line =
        e.type === "tool" ? `${e.name} ${e.summary}` : e.type === "agent" ? `agent ${e.agent}: ${e.description}` : e.type === "note" ? e.text : e.type === "error" ? `error: ${e.message}` : null;
      if (line) log.recent = [...log.recent, line].slice(-15);
    }) as () => void;
  }
  private log(tabId: string): TabLog {
    let l = this.logs.get(tabId);
    if (!l) this.logs.set(tabId, (l = { reply: "", questions: new Map(), recent: [] }));
    return l;
  }

  // ── HTTP / MCP ──
  private authorized(req: IncomingMessage): boolean {
    const m = (req.url ?? "").match(/^\/mcp\/([A-Za-z0-9_-]+)\/?(\?.*)?$/);
    const given = m?.[1] ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given);
    const b = Buffer.from(this.state.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.authorized(req)) return send(res, 404, { error: "not found" });
    if (req.method === "GET") return send(res, 405, { error: "This server answers POST requests (MCP Streamable HTTP, JSON responses)." });
    if (req.method === "DELETE") return send(res, 200, {});
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return send(res, 413, { error: "too large" });
    }
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => this.rpc(m)))).filter(Boolean);
      return out.length ? send(res, 200, out) : send(res, 202, null);
    }
    const out = await this.rpc(msg);
    return out ? send(res, 200, out) : send(res, 202, null);
  }

  /** One JSON-RPC message. Returns null for notifications. */
  async rpc(msg: any): Promise<object | null> {
    if (!msg || typeof msg !== "object") return rpcError(null, -32600, "Invalid request");
    const { id, method, params } = msg;
    if (id === undefined || id === null) return null; // notification
    try {
      switch (method) {
        case "initialize":
          return rpcResult(id, {
            protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "multi-agent-harness", version: "1.0.0" },
            instructions:
              "Controls the Multi-Agent Harness on the owner's computer. Use send_message to give a tab a task, then get_reply to wait for the answer. Check list_tabs first.",
          });
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: TOOLS });
        case "tools/call": {
          const text = await this.call(String(params?.name ?? ""), params?.arguments ?? {});
          return rpcResult(id, { content: [{ type: "text", text }] });
        }
        default:
          return rpcError(id, -32601, `Unknown method: ${method}`);
      }
    } catch (err) {
      if (method === "tools/call") return rpcResult(id, { content: [{ type: "text", text: (err as Error).message }], isError: true });
      return rpcError(id, -32603, (err as Error).message);
    }
  }

  private pickTab(id?: string): string {
    const tabs = this.host.list();
    if (id) {
      if (!tabs.some((t) => t.id === id)) throw new Error(`No tab ${id}. Use list_tabs.`);
      return id;
    }
    const t = (this.host.activeTab && tabs.find((x) => x.id === this.host.activeTab)) ?? tabs[tabs.length - 1];
    if (!t) throw new Error("The app has no open tabs. Use send_message with new_tab: true.");
    return t.id;
  }

  async call(name: string, a: Record<string, any>): Promise<string> {
    switch (name) {
      case "list_tabs": {
        const tabs = this.host.list();
        if (!tabs.length) return "No tabs are open.";
        return tabs
          .map((t) => `${t.id}${t.id === this.host.activeTab ? " (active)" : ""} · ${t.title} · ${t.model} · ${t.busy ? "working" : "idle"}${this.log(t.id).questions.size ? " · has a question waiting" : ""}`)
          .join("\n");
      }
      case "send_message": {
        const text = String(a.text ?? "").trim();
        if (!text) throw new Error("text is required.");
        let tabId: string;
        if (a.new_tab || !this.host.list().length) {
          const win = this.host.list()[0]?.windowId ?? 1;
          tabId = this.host.createTab({ windowId: win, model: a.model ? String(a.model) : undefined }).id;
        } else tabId = this.pickTab(a.tab_id);
        this.log(tabId).reply = "";
        this.host.send(tabId, text, "remote");
        return `Sent to tab ${tabId}. Call get_reply with tab_id "${tabId}" to wait for the answer.`;
      }
      case "get_reply": {
        const tabId = this.pickTab(a.tab_id);
        const wait = Math.min(Math.max(Number(a.wait_seconds ?? 50), 0), 110) * 1000;
        const end = Date.now() + wait;
        while (Date.now() < end) {
          const t = this.host.list().find((x) => x.id === tabId);
          if (!t?.busy || this.log(tabId).questions.size) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const t = this.host.list().find((x) => x.id === tabId);
        const log = this.log(tabId);
        const parts: string[] = [];
        if (log.questions.size)
          for (const [qid, qs] of log.questions) parts.push(`The agent is asking (question_id "${qid}"):\n${JSON.stringify(qs, null, 2)}\nAnswer with answer_question.`);
        if (t?.busy) parts.push(`Still working. Recent steps:\n${log.recent.slice(-6).join("\n") || "(thinking)"}\nCall get_reply again to keep waiting.`);
        if (log.reply) parts.push(`${t?.busy ? "Latest text so far" : "Reply"}:\n${log.reply}`);
        if (!parts.length) {
          const h = await this.host.history(tabId).catch(() => []);
          const last = [...h].reverse().find((x) => x.role === "assistant");
          parts.push(last ? `Last reply:\n${last.text}` : "No reply yet.");
        }
        return parts.join("\n\n");
      }
      case "read_chat": {
        const tabId = this.pickTab(a.tab_id);
        const n = Math.min(Math.max(Number(a.last ?? 20), 1), 200);
        const h = await this.host.history(tabId);
        return h.slice(-n).map((x) => `${x.role}: ${x.text}`).join("\n\n") || "This tab has no messages yet.";
      }
      case "answer_question": {
        const tabId = this.pickTab(a.tab_id);
        const log = this.log(tabId);
        const qid = String(a.question_id ?? [...log.questions.keys()][0] ?? "");
        const qs = log.questions.get(qid) as { question: string }[] | undefined;
        if (!qs) throw new Error("No question is waiting in that tab.");
        const answers: Record<string, string> = {};
        const given = a.answers && typeof a.answers === "object" ? a.answers : null;
        for (const q of qs) answers[q.question] = String(given?.[q.question] ?? a.answer ?? "(no answer, use your judgment)");
        if (!this.host.answer(tabId, qid, answers)) throw new Error("That question was already answered.");
        return "Answered. Call get_reply to wait for the result.";
      }
      case "stop": {
        const tabId = this.pickTab(a.tab_id);
        await this.host.stop(tabId);
        return `Stopped tab ${tabId}.`;
      }
      case "usage": {
        const u = this.host.usage;
        const g = this.host.gptUsage;
        const fmt = (s: typeof u) => (s?.windows ?? []).map((w) => `${w.label}: ${w.utilization == null ? "?" : Math.round(w.utilization * 100)}%`).join(", ") || "no data yet";
        return `Claude: ${fmt(u)}\nChatGPT: ${fmt(g)}`;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

const TOOLS = [
  { name: "list_tabs", description: "List the open tabs (chats) in the harness: id, title, model, and whether each is working.", inputSchema: { type: "object", properties: {} } },
  {
    name: "send_message",
    description: "Send a message or task to a tab, like typing it in the app. Without tab_id it goes to the active tab. Then call get_reply.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message. @app mentions and /shortcuts work as in the app." },
        tab_id: { type: "string" },
        new_tab: { type: "boolean", description: "Open a new tab for this task." },
        model: { type: "string", description: "Model for a new tab (optional)." },
      },
      required: ["text"],
    },
  },
  {
    name: "get_reply",
    description: "Wait for a tab to finish (or ask a question) and return the reply. Returns early with progress if it's still working after wait_seconds.",
    inputSchema: { type: "object", properties: { tab_id: { type: "string" }, wait_seconds: { type: "number", description: "Up to 110. Default 50." } } },
  },
  { name: "read_chat", description: "Read the last messages of a tab's chat.", inputSchema: { type: "object", properties: { tab_id: { type: "string" }, last: { type: "number" } } } },
  {
    name: "answer_question",
    description: "Answer a question the agent asked in a tab (shown by get_reply).",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string" }, question_id: { type: "string" }, answer: { type: "string" }, answers: { type: "object", description: "question text → answer, when there are several" } },
    },
  },
  { name: "stop", description: "Stop the work running in a tab.", inputSchema: { type: "object", properties: { tab_id: { type: "string" } } } },
  { name: "usage", description: "Claude and ChatGPT plan usage.", inputSchema: { type: "object", properties: {} } },
];

const newToken = () => randomBytes(24).toString("base64url");
const rpcResult = (id: unknown, result: object) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body === null ? "" : JSON.stringify(body));
}
/** cloudflared on PATH, or where Homebrew puts it (apps opened from the Finder don't get Homebrew's PATH). */
function cloudflaredBin(): string | null {
  if (spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"]).status === 0) return "cloudflared";
  for (const p of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]) if (existsSync(p)) return p;
  return null;
}
const cloudflaredAvailable = () => cloudflaredBin() !== null;
