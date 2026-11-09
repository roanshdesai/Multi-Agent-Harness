import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";

/** One usage window of the Claude plan (e.g. the 5-hour and weekly limits). */
export interface UsageWindow {
  key: string;
  label: string;
  utilization: number | null; // 0..1
  resetsAt: number | null; // epoch ms
  status: string;
}

export interface UsageSnapshot {
  at: number;
  status: "allowed" | "allowed_warning" | "rejected";
  windows: UsageWindow[];
  resetsAt: number | null;
  overage: string | null;
}

const LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  overage: "Extra usage",
};

const ms = (s?: number) => (typeof s === "number" ? (s < 1e12 ? s * 1000 : s) : null);

/** Turn the SDK's rate-limit info into something both apps can show. */
export function toSnapshot(info: SDKRateLimitInfo): UsageSnapshot {
  const windows: UsageWindow[] = [];
  const unified = (info as unknown as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }> }).unifiedWindows;
  if (unified) {
    for (const [key, w] of Object.entries(unified))
      windows.push({ key, label: LABELS[key] ?? key, utilization: w.utilization ?? null, resetsAt: ms(w.resetsAt), status: w.status ?? "allowed" });
  } else if (info.rateLimitType) {
    windows.push({ key: info.rateLimitType, label: LABELS[info.rateLimitType] ?? info.rateLimitType, utilization: info.utilization ?? null, resetsAt: ms(info.resetsAt), status: info.status });
  }
  return {
    at: Date.now(),
    status: info.status,
    windows,
    resetsAt: ms(info.resetsAt),
    overage: info.overageStatus ?? null,
  };
}

/** True when Claude can't take more requests right now (and extra usage isn't available). */
export function isExhausted(s: UsageSnapshot | null | undefined): boolean {
  if (!s) return false;
  if (s.resetsAt && s.resetsAt < Date.now()) return false;
  return s.status === "rejected" && s.overage !== "allowed" && s.overage !== "allowed_warning";
}

const file = (cfg: HarnessConfig) => join(cfg.root, ".harness", "usage.json");

export function saveUsage(cfg: HarnessConfig, s: UsageSnapshot) {
  mkdirSync(join(cfg.root, ".harness"), { recursive: true });
  writeFileSync(file(cfg), JSON.stringify(s, null, 2));
}

export function loadUsage(cfg: HarnessConfig): UsageSnapshot | null {
  if (!existsSync(file(cfg))) return null;
  try {
    return JSON.parse(readFileSync(file(cfg), "utf8"));
  } catch {
    return null;
  }
}

export function formatReset(at: number | null): string {
  if (!at) return "";
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** Plain-text summary used by the terminal's /usage. */
export function describeUsage(s: UsageSnapshot | null): string[] {
  if (!s) return ["No Claude usage reported yet. It appears after your first message."];
  const lines = s.windows.map((w) => {
    const pct = w.utilization === null ? "?" : `${Math.round(w.utilization * 100)}%`;
    const bar = w.utilization === null ? "" : `${"█".repeat(Math.round(w.utilization * 20)).padEnd(20, "░")} `;
    return `${w.label.padEnd(20)} ${bar}${pct}${w.resetsAt ? `  · resets ${formatReset(w.resetsAt)}` : ""}`;
  });
  if (isExhausted(s)) lines.push(`Claude is at its limit until ${formatReset(s.resetsAt)}. New work goes to GPT until then.`);
  else if (s.status === "allowed_warning") lines.push("Getting close to the limit.");
  lines.push(`(as of ${new Date(s.at).toLocaleTimeString()})`);
  return lines;
}
