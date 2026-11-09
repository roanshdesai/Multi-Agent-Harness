import { createServer, createConnection, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "./host.js";

/**
 * Local link between the desktop app and terminals. The app hosts it; a
 * terminal that starts while the app is open attaches to it, so a message typed
 * in either shows up in both. Unix socket in ~/.agent-harness (owner-only) or a
 * named pipe on Windows. Messages are newline-delimited JSON.
 */
export function bridgePath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\agent-harness-${process.env.USERNAME ?? "user"}`;
  return join(homedir(), ".agent-harness", "bridge.sock");
}

type Req = { id: number; op: string; [k: string]: unknown };

export function startBridge(host: Host, onOpenTab: (tabId: string) => void, defaultWindow: () => number): Server {
  const path = bridgePath();
  if (process.platform !== "win32") {
    mkdirSync(join(homedir(), ".agent-harness"), { recursive: true });
    if (existsSync(path)) unlinkSync(path); // stale socket from a crash
  }
  const server = createServer((sock: Socket) => {
    const write = (o: unknown) => !sock.destroyed && sock.write(JSON.stringify(o) + "\n");
    const off = host.listen((msg) => write(msg));
    let buf = "";
    sock.on("data", async (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req: Req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          write({ id: req.id, ok: true, result: await handle(host, req, onOpenTab, defaultWindow) });
        } catch (err) {
          write({ id: req.id, ok: false, error: (err as Error).message });
        }
      }
    });
    sock.on("close", () => off());
    sock.on("error", () => off());
    write({ type: "tabs", tabs: host.list() });
  });
  server.listen(path, () => {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  });
  return server;
}

async function handle(host: Host, r: Req, onOpenTab: (id: string) => void, defaultWindow: () => number) {
  const tabId = String(r.tabId ?? "");
  switch (r.op) {
    case "hello":
      return { tabs: host.list(), active: host.activeTab, plan: host.plan ?? null, cwd: process.cwd() };
    case "tabs":
      return host.list();
    case "history":
      return host.history(tabId);
    case "send":
      host.send(tabId, String(r.text), "terminal");
      return true;
    case "stop":
      await host.stop(tabId);
      return true;
    case "btw":
      return host.btw(tabId, String(r.q));
    case "new-tab": {
      const info = host.createTab({ windowId: defaultWindow(), model: r.model ? String(r.model) : undefined });
      onOpenTab(info.id);
      return info;
    }
    case "open-chat": {
      const info = host.createTab({ windowId: defaultWindow(), chatId: String(r.chatId) });
      onOpenTab(info.id);
      return { tab: info, history: await host.history(info.id) };
    }
    case "chats":
      return host.chats(50);
    case "fork":
      return host.fork(tabId, r.title ? String(r.title) : undefined);
    case "set-model":
      return host.setModel(tabId, String(r.model));
    case "change":
      host.change(tabId, String(r.text), "terminal");
      return true;
    case "context":
      return host.context(tabId);
    case "answer":
      return host.answer(tabId, String(r.qid), (r.answers ?? {}) as Record<string, string>);
    case "usage":
      return host.usage;
    default:
      throw new Error(`Unknown op ${r.op}`);
  }
}

/** Terminal side: connect if the app is running. Resolves null quickly otherwise. */
export function connectBridge(timeoutMs = 400): Promise<BridgeClient | null> {
  return new Promise((resolve) => {
    const path = bridgePath();
    if (process.platform !== "win32" && !existsSync(path)) return resolve(null);
    const sock = createConnection(path);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(new BridgeClient(sock));
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export class BridgeClient {
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private pushHandlers = new Set<(msg: any) => void>();
  onClose?: () => void;

  constructor(private sock: Socket) {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
        } else for (const h of this.pushHandlers) h(msg);
      }
    });
    sock.on("close", () => this.onClose?.());
  }

  request<T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  onPush(fn: (msg: any) => void) {
    this.pushHandlers.add(fn);
  }

  close() {
    this.sock.end();
  }
}
