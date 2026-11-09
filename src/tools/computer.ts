import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { HarnessConfig } from "../config.js";
import { codexBin, codexStatus, subscriptionEnv } from "../subscription.js";

/**
 * Computer use on your ChatGPT plan: `codex exec` with the GPT model for UI work
 * (models.gui, e.g. GPT-6 Astra) and Codex's computer-use and browser-use
 * features. Which Mac apps it may touch comes from `computer_use` in
 * harness.config.yaml; every other app is denied.
 */

export interface ComputerResult {
  ok: boolean;
  text: string;
  /** Folder with the log (and anything Codex saved). */
  dir: string;
}

/** The test run by `/computer test`: look, don't touch. */
export const COMPUTER_TEST_PROMPT =
  "This is a permissions check for computer use. Take one screenshot of the screen and describe in two sentences what you see: which app is in front and roughly what is on screen. Do not click, type, scroll or open anything. If you cannot take a screenshot, say exactly what stopped you (for example a missing macOS permission).";

/** Codex `-c` overrides for computer and browser use, from harness.config.yaml. */
export function computerArgs(cfg: HarnessConfig): string[] {
  const cu = cfg.computer_use;
  const out: string[] = [];
  out.push("-c", `computer_use.default_app_access="${cu?.default_app_access === "allow" ? "allow" : "deny"}"`);
  for (const [bundle, access] of Object.entries(cu?.apps ?? {})) {
    if (!/^[A-Za-z0-9.-]+$/.test(bundle)) continue; // bundle ids only
    out.push("-c", `computer_use.macos.bundle_ids."${bundle}"="${access === "allow" ? "allow" : "deny"}"`);
  }
  const b = cu?.browser;
  if (b) {
    const p = (k: string, v?: string) => (v ? ["-c", `browser_use.default_origin_policy.${k}="${v === "allow" ? "allow" : "deny"}"`] : []);
    out.push(...p("access", b.access), ...p("downloads", b.downloads), ...p("uploads", b.uploads));
  }
  return out;
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
      if (code === 0 && text) resolve({ ok: true, text, dir });
      else resolve({ ok: false, text: `Codex computer use failed (exit ${code}).\n${(text || out).slice(-1500)}`, dir });
    });
  });
}

/** The tool the orchestrator (and the GUI tester) can call. */
export function computerUseTool(cfg: HarnessConfig) {
  return tool(
    "computer_use",
    "Operate this Mac's apps and screen with GPT through Codex (computer use): look at the screen, click, type, use apps. Only the apps allowed under computer_use in harness.config.yaml can be touched. Give one clear task and what to report back.",
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
