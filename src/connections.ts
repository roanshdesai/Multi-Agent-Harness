import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { claudeBin } from "./terminal.js";
import { subscriptionEnv } from "./subscription.js";
import { join } from "node:path";
import type { McpServerConfig, McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";

/**
 * Connections: every MCP server the agents can use — the harness's own
 * (GitHub, Slack, Outlook…), ones from your Claude Code setup (user/project
 * config, plugins, claude.ai connectors), and servers you add here.
 */
export interface ConnectionInfo {
  name: string;
  status: McpServerStatus["status"];
  source: string; // harness | yours | user | project | plugin | claudeai | …
  tools: number;
  error?: string;
  target?: string; // URL or command, for display
  enabled: boolean;
  removable: boolean;
  /** Needs a sign-in (OAuth) that the app opens in a terminal. */
  signIn?: boolean;
}

const customFile = (cfg: HarnessConfig) => join(cfg.root, "mcp-servers.json");
const disabledFile = (cfg: HarnessConfig) => join(cfg.root, ".harness", "mcp-disabled.json");

/** Servers you added from the app or terminal. Same shape as Claude Code's mcpServers. */
export function loadCustomServers(cfg: HarnessConfig): Record<string, McpServerConfig> {
  if (!existsSync(customFile(cfg))) return {};
  try {
    const data = JSON.parse(readFileSync(customFile(cfg), "utf8"));
    return data?.mcpServers ?? data ?? {};
  } catch {
    return {};
  }
}

export function saveCustomServer(cfg: HarnessConfig, name: string, conf: McpServerConfig) {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!clean || clean === "harness") throw new Error("Pick another name.");
  const all = { ...loadCustomServers(cfg), [clean]: conf };
  writeFileSync(customFile(cfg), JSON.stringify({ mcpServers: all }, null, 2) + "\n");
  return clean;
}

/** Run `claude mcp …` (Claude Code's own server list, user scope). */
function claudeMcp(args: string[]): { ok: boolean; out: string } {
  const bin = claudeBin();
  if (!bin) return { ok: false, out: "Claude Code isn't installed, so the server was saved in mcp-servers.json instead." };
  const r = spawnSync(bin, ["mcp", ...args], { encoding: "utf8", timeout: 30000, env: subscriptionEnv() });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

/**
 * Add a server from the app. URL servers go into Claude Code's own list (user
 * scope), so its sign-in (OAuth) works and every tab picks them up; commands
 * go into mcp-servers.json. Re-adding a server also turns it back on.
 */
export function addServer(cfg: HarnessConfig, name: string, spec: string): { name: string; where: "claude-code" | "harness"; note?: string } {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!clean || clean === "harness") throw new Error("Pick another name.");
  const conf = parseServerSpec(spec);
  setDisabled(cfg, clean, false);
  if ("url" in conf && conf.type === "http") {
    claudeMcp(["remove", "--scope", "user", clean]); // replace an old entry of the same name
    const headers = Object.entries(conf.headers ?? {}).flatMap(([k, v]) => ["--header", `${k}: ${v}`]);
    const r = claudeMcp(["add", "--transport", "http", "--scope", "user", ...headers, clean, conf.url]);
    if (r.ok) {
      removeCustomServer(cfg, clean);
      return { name: clean, where: "claude-code" };
    }
    saveCustomServer(cfg, clean, conf);
    return { name: clean, where: "harness", note: r.out };
  }
  saveCustomServer(cfg, clean, conf);
  return { name: clean, where: "harness" };
}

/** Remove a server the user added: from mcp-servers.json and/or Claude Code's user list. */
export function removeServer(cfg: HarnessConfig, name: string): boolean {
  const local = removeCustomServer(cfg, name);
  const cc = claudeMcp(["remove", "--scope", "user", name]).ok;
  if (local || cc) setDisabled(cfg, name, false);
  return local || cc;
}

export function removeCustomServer(cfg: HarnessConfig, name: string): boolean {
  const all = loadCustomServers(cfg);
  if (!(name in all)) return false;
  delete all[name];
  writeFileSync(customFile(cfg), JSON.stringify({ mcpServers: all }, null, 2) + "\n");
  return true;
}

export function loadDisabled(cfg: HarnessConfig): string[] {
  try {
    return JSON.parse(readFileSync(disabledFile(cfg), "utf8"));
  } catch {
    return [];
  }
}

export function setDisabled(cfg: HarnessConfig, name: string, disabled: boolean) {
  const set = new Set(loadDisabled(cfg));
  if (disabled) set.add(name);
  else set.delete(name);
  mkdirSync(join(cfg.root, ".harness"), { recursive: true });
  writeFileSync(disabledFile(cfg), JSON.stringify([...set], null, 2));
}

/** Parse "add server" input: a URL, or a command line. */
export function parseServerSpec(spec: string, env: Record<string, string> = {}): McpServerConfig {
  const s = spec.trim();
  if (/^https?:\/\//.test(s)) {
    const [url, ...rest] = s.split(/\s+/);
    const headers: Record<string, string> = {};
    for (const h of rest) {
      const m = h.match(/^([^=]+)=(.*)$/);
      if (m) headers[m[1]] = m[2];
    }
    return { type: "http", url, ...(Object.keys(headers).length && { headers }) };
  }
  const parts = s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((p) => p.replace(/^["']|["']$/g, "")) ?? [];
  if (!parts.length) throw new Error("Give a URL or a command, e.g. npx -y @modelcontextprotocol/server-filesystem ~/Documents");
  return { command: parts[0], args: parts.slice(1), ...(Object.keys(env).length && { env }) };
}

function target(conf: unknown): string | undefined {
  const c = conf as { url?: string; command?: string; args?: string[] } | undefined;
  if (!c) return undefined;
  if (c.url) return c.url;
  if (c.command) return [c.command, ...(c.args ?? [])].join(" ").slice(0, 120);
  return undefined;
}

const ORDER = ["yours", "harness", "user", "project", "local", "claudeai"];
const rank = (c: ConnectionInfo) => (ORDER.includes(c.source) ? ORDER.indexOf(c.source) : ORDER.length) * 2 + (c.status === "connected" ? 0 : 1);

/** Wait for servers to finish connecting, then describe them. */
export async function readConnections(q: Query, cfg: HarnessConfig, harnessNames: string[], waitMs = 15000): Promise<ConnectionInfo[]> {
  const end = Date.now() + waitMs;
  let list: McpServerStatus[] = [];
  do {
    list = await q.mcpServerStatus();
    if (!list.some((s) => s.status === "pending")) break;
    await new Promise((r) => setTimeout(r, 700));
  } while (Date.now() < end);
  const custom = loadCustomServers(cfg);
  const disabled = new Set(loadDisabled(cfg));
  return list
    .filter((s) => s.name !== "harness")
    .map((s) => {
      const tools = Array.isArray(s.tools) ? s.tools.length : s.tools ? 1 : 0;
      const source = s.name in custom ? "yours" : harnessNames.includes(s.name) ? "harness" : (s.source ?? s.scope ?? "user");
      return {
        name: s.name,
        status: disabled.has(s.name) ? "disabled" : s.status,
        source,
        tools,
        error: s.error,
        target: target(s.config) ?? target(custom[s.name]),
        enabled: !disabled.has(s.name),
        removable: s.name in custom || source === "user",
        signIn: s.status === "needs-auth",
      } satisfies ConnectionInfo;
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
