import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import OpenAI from "openai";

type Action =
  | { action: "click"; x: number; y: number; why?: string }
  | { action: "type"; text: string; why?: string }
  | { action: "key"; key: string; why?: string }
  | { action: "scroll"; dy: number; why?: string }
  | { action: "goto"; url: string; why?: string }
  | { action: "wait"; ms: number; why?: string }
  | { action: "done"; report: string; passed: boolean };

const SYSTEM = `You are a GUI test agent controlling a browser through screenshots.
Viewport is 1280x800. On every step reply with ONE JSON object, one of:
{"action":"click","x":int,"y":int,"why":str}
{"action":"type","text":str,"why":str}
{"action":"key","key":"Enter|Tab|Escape|...","why":str}
{"action":"scroll","dy":int,"why":str}
{"action":"goto","url":str,"why":str}
{"action":"wait","ms":int,"why":str}
{"action":"done","passed":bool,"report":"each checklist item as PASS/FAIL with evidence"}
Be precise. Stop with "done" once every checklist item is decided.`;

/**
 * GUI testing tool driven by an OpenAI vision model (GPT-6 Astra by default).
 * Errors are returned with isError so the gui-tester agent falls back to Playwright MCP.
 */
export function guiTestTool(model: string, outRoot: string) {
  return tool(
    "gui_test",
    "Run a GUI test in a real Chromium browser, driven by the GPT-6 Astra vision model. Give a URL and a checklist.",
    {
      url: z.string().url(),
      checklist: z.string().describe("What to verify, one item per line"),
      max_steps: z.number().int().min(1).max(60).optional(),
    },
    async ({ url, checklist, max_steps }) => {
      if (!process.env.OPENAI_API_KEY) {
        return { isError: true, content: [{ type: "text", text: "OPENAI_API_KEY not set; use Playwright MCP fallback." }] };
      }
      const { chromium } = await import("playwright");
      const openai = new OpenAI();
      const dir = join(outRoot, `gui-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const consoleErrors: string[] = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      const log: string[] = [];
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        const history: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: SYSTEM },
          { role: "user", content: `URL: ${url}\nChecklist:\n${checklist}` },
        ];
        for (let step = 0; step < (max_steps ?? 30); step++) {
          const shot = await page.screenshot();
          const shotPath = join(dir, `step-${String(step).padStart(2, "0")}.png`);
          writeFileSync(shotPath, shot);
          history.push({
            role: "user",
            content: [
              { type: "text", text: `Step ${step}. Current URL: ${page.url()}. Console errors so far: ${consoleErrors.length}` },
              { type: "image_url", image_url: { url: `data:image/png;base64,${shot.toString("base64")}` } },
            ],
          });
          const res = await openai.chat.completions.create({
            model,
            messages: history,
            response_format: { type: "json_object" },
          });
          const text = res.choices[0]?.message?.content ?? "{}";
          history.push({ role: "assistant", content: text });
          // Keep only the last 4 screenshots in context
          const imgIdx = history.map((m, i) => (Array.isArray(m.content) ? i : -1)).filter((i) => i >= 0);
          for (const i of imgIdx.slice(0, -4)) history[i] = { role: "user", content: "(earlier screenshot removed)" };

          const a = JSON.parse(text) as Action;
          log.push(`${step}: ${text}`);
          if (a.action === "done") {
            return {
              content: [{
                type: "text",
                text: `${a.passed ? "PASSED" : "FAILED"}\n${a.report}\n\nConsole errors:\n${consoleErrors.join("\n") || "(none)"}\nScreenshots: ${dir}`,
              }],
            };
          }
          if (a.action === "click") await page.mouse.click(a.x, a.y);
          else if (a.action === "type") await page.keyboard.type(a.text);
          else if (a.action === "key") await page.keyboard.press(a.key);
          else if (a.action === "scroll") await page.mouse.wheel(0, a.dy);
          else if (a.action === "goto") await page.goto(a.url);
          else if (a.action === "wait") await page.waitForTimeout(Math.min(a.ms, 10_000));
          await page.waitForLoadState("domcontentloaded").catch(() => {});
        }
        return { isError: true, content: [{ type: "text", text: `Ran out of steps.\n${log.join("\n")}\nScreenshots: ${dir}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `gui_test failed: ${(err as Error).message}. Use the Playwright MCP fallback.` }] };
      } finally {
        await browser.close();
      }
    },
  );
}
