import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { codexBin, codexStatus, subscriptionEnv } from "../subscription.js";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "checks", "console_errors"],
  properties: {
    passed: { type: "boolean" },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "status", "evidence"],
        properties: {
          item: { type: "string" },
          status: { type: "string", enum: ["PASS", "FAIL"] },
          evidence: { type: "string" },
        },
      },
    },
    console_errors: { type: "array", items: { type: "string" } },
  },
};

/**
 * GUI testing on your ChatGPT subscription: runs `codex exec` with GPT-6 Astra,
 * which drives a headless browser through the Playwright MCP server.
 * Errors come back with isError so the gui-tester agent falls back to Claude + Playwright MCP.
 */
export function guiTestTool(model: string, root: string) {
  return tool(
    "gui_test",
    "Run a GUI test in a real headless browser, driven by GPT-6 Astra (via your ChatGPT subscription). Give a URL and a checklist.",
    {
      url: z.string().url(),
      checklist: z.string().describe("What to verify, one item per line"),
      timeout_minutes: z.number().int().min(1).max(60).optional(),
    },
    async ({ url, checklist, timeout_minutes }) => {
      const status = codexStatus(root);
      if (!status.ok) {
        return { isError: true, content: [{ type: "text", text: `gui_test unavailable: ${status.detail}. Use the Playwright MCP fallback.` }] };
      }
      const dir = join(root, "out", `gui-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const schemaFile = join(dir, "schema.json");
      const resultFile = join(dir, "result.json");
      writeFileSync(schemaFile, JSON.stringify(RESULT_SCHEMA));

      const prompt = `You are a meticulous GUI tester. Use the Playwright browser tools to open ${url} and verify each checklist item.
Interact like a real user (click, type, scroll, resize to mobile 390x844 when layout matters). Take a screenshot as evidence for every item.
Record browser console errors. Do not modify any files except screenshots.

Checklist:
${checklist}`;

      const args = [
        "exec",
        "-m", model,
        "--skip-git-repo-check",
        "--ephemeral",
        "-s", "read-only",
        "-C", dir,
        "-c", 'approval_policy="never"',
        "-c", 'mcp_servers.playwright.command="npx"',
        "-c", `mcp_servers.playwright.args=["-y","@playwright/mcp@latest","--headless","--output-dir",${JSON.stringify(dir)}]`,
        "--output-schema", schemaFile,
        "-o", resultFile,
        prompt,
      ];

      const log = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(codexBin(root), args, { env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        const timer = setTimeout(() => child.kill("SIGTERM"), (timeout_minutes ?? 15) * 60_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, out });
        });
      });
      writeFileSync(join(dir, "codex.log"), log.out);

      if (log.code !== 0 || !existsSync(resultFile)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Codex GUI test failed (exit ${log.code}). Log: ${join(dir, "codex.log")}\n${log.out.slice(-1500)}\nUse the Playwright MCP fallback.` }],
        };
      }
      try {
        const r = JSON.parse(readFileSync(resultFile, "utf8"));
        const lines = r.checks.map((c: any) => `${c.status}  ${c.item}\n      ${c.evidence}`);
        return {
          content: [{
            type: "text",
            text: `${r.passed ? "PASSED" : "FAILED"} (GPT-6 Astra via Codex)\n${lines.join("\n")}\n\nConsole errors:\n${r.console_errors.join("\n") || "(none)"}\nScreenshots and log: ${dir}`,
          }],
        };
      } catch {
        return { content: [{ type: "text", text: readFileSync(resultFile, "utf8") + `\nScreenshots: ${dir}` }] };
      }
    },
  );
}
