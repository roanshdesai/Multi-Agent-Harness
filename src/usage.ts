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
  // No top-level reset time: use the latest reset of a blocked window, so a block can expire.
  const blocked = windows.filter((w) => w.status === "rejected" && w.resetsAt).map((w) => w.resetsAt!);
  return {
    at: Date.now(),
    status: info.status,
    windows,
    resetsAt: ms(info.resetsAt) ?? (blocked.length ? Math.max(...blocked) : null),
    overage: info.overageStatus ?? null,
  };
}

/** The plan-usage reply from the SDK's usage call (windows are 0-100). */
export interface PlanUsageReply {
  rate_limits_available?: boolean;
  rate_limits?: Record<string, unknown> | null;
}

/** Turn the SDK's on-demand plan usage into a snapshot. Null when the plan has no limits to show. */
export function fromPlanUsage(r: PlanUsageReply | null | undefined, warnAt = 1): UsageSnapshot | null {
  if (!r?.rate_limits_available || !r.rate_limits) return null;
  const windows: UsageWindow[] = [];
  for (const [key, v] of Object.entries(r.rate_limits)) {
    const w = v as { utilization?: number | null; resets_at?: string | null } | null;
    if (!w || typeof w !== "object" || Array.isArray(w) || !("utilization" in w)) continue;
    const u = typeof w.utilization === "number" ? w.utilization / 100 : null;
    windows.push({ key, label: LABELS[key] ?? key, utilization: u, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, status: u !== null && u >= 1 ? "rejected" : "allowed" });
  }
  if (!windows.length) return null;
  const blocked = windows.filter((w) => w.status === "rejected" && w.resetsAt && !/overage|_opus$|_sonnet$|oauth_apps/.test(w.key));
  const warn = windows.some((w) => (w.utilization ?? 0) >= warnAt);
  return {
    at: Date.now(),
    status: blocked.length ? "rejected" : warn ? "allowed_warning" : "allowed",
    windows,
    resetsAt: blocked.length ? Math.max(...blocked.map((w) => w.resetsAt!)) : null,
    overage: null,
  };
}

/** True when Claude can't take more requests right now (and extra usage isn't available). */
// Windows that only cover extra (paid) usage or one model: being out of these isn't being out of Claude.
const PARTIAL = /overage|_opus$|_sonnet$/;

export function isExhausted(s: UsageSnapshot | null | undefined): boolean {
  if (!s || s.status !== "rejected") return false;
  if (s.overage === "allowed" || s.overage === "allowed_warning") return false;
  // Without a reset time we can't tell when it ends, so don't trust an old "rejected" forever.
  if (!s.resetsAt || s.resetsAt <= Date.now()) return false;
  // The plan itself must be blocked, not just extra usage or a single model's window.
  const blocked = s.windows.filter((w) => w.status === "rejected" || (w.utilization ?? 0) >= 1);
  return blocked.length === 0 || blocked.some((w) => !PARTIAL.test(w.key));
}

/** Claude just answered, so it isn't out: clear a stale block. */
export function markWorking(s: UsageSnapshot): UsageSnapshot {
  return s.status === "rejected" ? { ...s, at: Date.now(), status: "allowed", resetsAt: null } : s;
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
