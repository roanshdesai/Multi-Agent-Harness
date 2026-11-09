import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HarnessConfig } from "../config.js";
import { codexBin, codexStatus, subscriptionEnv } from "../subscription.js";

/**
 * Computer use on your ChatGPT plan: `codex exec` with the GPT model for UI work
 * (models.gui, e.g. GPT-6 Astra) and Codex's computer-use and browser-use
 * features. `computer_use` in harness.config.yaml is passed on as Codex
 * settings, but which Mac apps it may touch is decided by the ChatGPT app's
 * approvals (see approvalHint).
 */

export interface ComputerResult {
  ok: boolean;
  text: string;
  /** Folder with the log (and anything Codex saved). */
  dir: string;
}

/** The test run by `/computer test`: look, don't touch. */
export const COMPUTER_TEST_PROMPT =
  "This is a permissions check for computer use. Read the current state (with its screenshot) of one app, trying Finder, then Google Chrome, then Safari, and stop at the first one that works. Don't use the frontmost app: it is usually Multi-Agent Harness itself, which computer use doesn't operate. Do not click, type, scroll or open anything. Then describe in two sentences which app you read and what you see. If none worked, give the exact error for each (for example a missing macOS permission or an app that wasn't approved).";

/** Codex `-c` overrides for computer and browser use, from harness.config.yaml. */
export function computerArgs(cfg: HarnessConfig): string[] {
  const cu = cfg.computer_use;
  const out: string[] = [];
  out.push("-c", `computer_use.default_app_access="${cu?.default_app_access === "allow" ? "allow" : "deny"}"`);
  // One inline table: Codex's -c splits a dotted key at every dot, even inside quotes,
  // so `bundle_ids."com.google.Chrome"=…` fails to load.
  const apps = Object.entries(cu?.apps ?? {})
    .filter(([bundle]) => /^[A-Za-z0-9.-]+$/.test(bundle)) // bundle ids only
    .map(([bundle, access]) => `"${bundle}"="${access === "allow" ? "allow" : "deny"}"`);
  if (apps.length) out.push("-c", `computer_use.macos.bundle_ids={${apps.join(",")}}`);
  const b = cu?.browser;
  if (b) {
    const p = (k: string, v?: string) => (v ? ["-c", `browser_use.default_origin_policy.${k}="${v === "allow" ? "allow" : "deny"}"`] : []);
    out.push(...p("access", b.access), ...p("downloads", b.downloads), ...p("uploads", b.uploads));
  }
  return out;
}

/** Codex's MCP servers that use a local port, from its config.toml: port → server name. */
export function localMcpPorts(configToml: string): Map<string, string> {
  const ports = new Map<string, string>();
  let server = "";
  for (const line of configToml.split("\n")) {
    const h = line.match(/^\s*\[mcp_servers\.("?)([^"\]]+)\1\]/);
    if (h) server = h[2];
    else if (/^\s*\[/.test(line)) server = "";
    const u = server && line.match(/^\s*url\s*=\s*"https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/);
    if (u) ports.set(u[1], server);
  }
  return ports;
}

/**
 * Local services Codex couldn't reach, named by the MCP server that uses each
 * port. On the Mac, 19789 turned out to be an unrelated server (palmier-pro),
 * not computer use, so this says which one it is instead of guessing.
 */
export function helperDown(log: string, configToml = ""): string | null {
  // "failed … 127.0.0.1:19789" or "127.0.0.1:19789 … refused", on one line.
  const re = /(?:connect|connection|refused|failed|error)[^\n]{0,160}?(?:127\.0\.0\.1|localhost):(\d{2,5})|(?:127\.0\.0\.1|localhost):(\d{2,5})[^\n]{0,120}?(?:refused|failed|error|unreachable)/gi;
  const down = new Set<string>();
  for (const m of log.matchAll(re)) down.add(m[1] ?? m[2]);
  if (!down.size) return null;
  const names = localMcpPorts(configToml);
  return [...down]
    .map((port) => {
      const name = names.get(port);
      return name
        ? `Codex's MCP server "${name}" (127.0.0.1:${port}) isn't running. Start the app that provides it, or turn it off in ~/.codex/config.toml (enabled = false) if you don't use it.`
        : `Nothing answered on 127.0.0.1:${port}, a local service Codex tried to use.`;
    })
    .join("\n");
}

function codexConfig(): string {
  try {
    return readFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Which Mac apps computer use may operate is set in the ChatGPT app (Computer
 * Use → apps), not by Codex's -c flags: on the Mac, `codex exec` refused Finder
 * even with computer_use.macos.bundle_ids allowing it, and used Chrome (approved
 * in the ChatGPT app) with no flags at all. `codex exec` can't show the approval
 * prompt, so an app that isn't approved there is refused. Say how to fix it.
 */
export function approvalHint(text: string): string | null {
  const apps = [...new Set([...text.matchAll(/not approved to use ([^.”"\n]+)/gi)].map((m) => m[1].trim()))];
  if (!apps.length) return null;
  return `Computer use isn't approved for ${apps.join(", ")} yet. Approve it once in the ChatGPT app (start a computer-use task there that uses ${apps.length > 1 ? "these apps" : "that app"} and choose Always allow), then try again here. The app list in harness.config.yaml can't grant this by itself.`;
}

/** Run one computer-use task with Codex. */
export function runComputerUse(cfg: HarnessConfig, task: string, opts: { timeoutMinutes?: number } = {}): Promise<ComputerResult> {
  const dir = join(cfg.root, "out", `computer-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const status = codexStatus(cfg.root);
  if (!status.ok) return Promise.resolve({ ok: false, text: `Codex isn't ready: ${status.detail}`, dir });
  const resultFile = join(dir, "result.txt");
  const args = [
    "exec",
    "-m", cfg.models.gui,
    "--skip-git-repo-check",
    "--ephemeral",
    "-s", "read-only",
    "-C", dir,
    "-c", 'approval_policy="never"',
    ...computerArgs(cfg),
    "-o", resultFile,
    task,
  ];
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(codexBin(cfg.root), args, { env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, text: (err as Error).message, dir });
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), (opts.timeoutMinutes ?? cfg.computer_use?.timeout_minutes ?? 15) * 60_000);
    child.on("error", (err) => (out += `\n${err.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(join(dir, "codex.log"), out);
      let text = "";
      try {
        text = readFileSync(resultFile, "utf8").trim();
      } catch {
        /* no final message */
      }
      // A finished task counts even if some unrelated MCP server was down.
      if (code === 0 && text) {
        const hint = approvalHint(text);
        // GPT's reply says what worked; the hint is a note, not a verdict.
        return resolve({ ok: true, text: hint ? `${text}\n\n${hint}` : text, dir });
      }
      const helper = helperDown(out, codexConfig());
      resolve({ ok: false, text: `Codex computer use failed (exit ${code}).\n${(text || out).slice(-1500)}${helper ? `\n\n${helper}` : ""}`, dir });
    });
  });
}

/** The tool the orchestrator (and the GUI tester) can call. */
export function computerUseTool(cfg: HarnessConfig) {
  return tool(
    "computer_use",
    "Operate this Mac's apps and screen with GPT through Codex (computer use): look at the screen, click, type, use apps. It can only use apps approved for Computer Use in the ChatGPT app, and it doesn't operate this app (Multi-Agent Harness). Give one clear task and what to report back.",
    {
      task: z.string().describe("What to do, step by step if it matters, and what to report"),
      timeout_minutes: z.number().int().min(1).max(60).optional(),
    },
    async ({ task, timeout_minutes }) => {
      const r = await runComputerUse(cfg, task, { timeoutMinutes: timeout_minutes });
      return { ...(r.ok ? {} : { isError: true }), content: [{ type: "text", text: `${r.text}\n\n(${cfg.models.gui} via Codex · log: ${join(r.dir, "codex.log")})` }] };
    },
  );
}
