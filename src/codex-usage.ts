import { spawn } from "node:child_process";
import { codexBin, subscriptionEnv } from "./subscription.js";
import type { UsageSnapshot, UsageWindow } from "./usage.js";

/** One usage window as Codex's app server reports it. */
interface CodexWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null; // unix seconds
}
interface CodexSnapshot {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

/** "5-hour limit", "Weekly limit", or the window's length when it is neither. */
function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins % 10080 === 0) return mins === 10080 ? "Weekly limit" : `${mins / 10080}-week limit`;
  if (mins % 1440 === 0) return `${mins / 1440}-day limit`;
  if (mins % 60 === 0) return `${mins / 60}-hour limit`;
  return `${mins}-minute limit`;
}

/** Turn Codex's rate-limit reply into the same shape as Claude's usage. Null if it has no windows. */
export function fromCodexRateLimits(r: { rateLimits?: CodexSnapshot | null } | null | undefined, warnAt = 1): (UsageSnapshot & { plan?: string }) | null {
  const s = r?.rateLimits;
  if (!s) return null;
  const windows: UsageWindow[] = [];
  for (const [key, w] of [["primary", s.primary], ["secondary", s.secondary]] as const) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const u = w.usedPercent / 100;
    windows.push({
      key,
      label: windowLabel(w.windowDurationMins, key === "primary" ? "Short-term limit" : "Longer-term limit"),
      utilization: u,
      resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
      status: u >= 1 ? "rejected" : "allowed",
    });
  }
  if (!windows.length) return null;
  const blocked = windows.filter((w) => w.status === "rejected" && w.resetsAt);
  return {
    at: Date.now(),
    status: s.rateLimitReachedType || blocked.length ? "rejected" : windows.some((w) => (w.utilization ?? 0) >= warnAt) ? "allowed_warning" : "allowed",
    windows,
    resetsAt: blocked.length ? Math.max(...blocked.map((w) => w.resetsAt!)) : null,
    overage: null,
    plan: s.planType ?? undefined,
  };
}

/**
 * Ask Codex (signed in with your ChatGPT plan) for its usage, through its app
 * server: initialize, then account/rateLimits/read. Resolves null if Codex
 * isn't signed in, doesn't support it, or doesn't answer in time.
 */
export function readCodexUsage(root: string, opts: { timeoutMs?: number; warnAt?: number } = {}): Promise<(UsageSnapshot & { plan?: string }) | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexBin(root), ["app-server"], { env: subscriptionEnv(), stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    let done = false;
    const finish = (v: (UsageSnapshot & { plan?: string }) | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), opts.timeoutMs ?? 20000);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (msg.id === 2) {
          finish(msg.error ? null : fromCodexRateLimits(msg.result as { rateLimits?: CodexSnapshot }, opts.warnAt));
        }
      }
    });
    const send = (m: object) => child.stdin!.write(JSON.stringify(m) + "\n");
    child.stdin!.on("error", () => finish(null));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "multi-agent-harness", version: "1" } } });
  });
}
