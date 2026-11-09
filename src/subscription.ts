import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * Subscription-only mode: Claude runs on your Claude plan (Pro/Max/Team login)
 * and GPT runs on your ChatGPT plan through the Codex CLI.
 * Any API-key style credential is removed so nothing can fall back to API billing.
 */
export const API_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

export function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of API_CREDENTIAL_VARS) delete env[k];
  return env;
}

export class SubscriptionError extends Error {}

/** Throws unless the Claude login is a subscription (not an API key, Console key, or cloud provider). */
export function assertClaudeSubscription(info: AccountInfo): string {
  const plan = info.subscriptionType ?? "";
  const viaKey = info.apiKeySource && info.apiKeySource !== "none";
  const thirdParty = info.apiProvider && info.apiProvider !== "firstParty";
  if (viaKey || thirdParty || !plan || /api/i.test(plan)) {
    throw new SubscriptionError(
      `Claude is not signed in with a subscription (plan: ${plan || "none"}, key source: ${info.apiKeySource ?? "?"}, provider: ${info.apiProvider ?? "?"}).\n` +
        `Open Claude Code (\`claude\`), run /login and choose your Claude account (Pro/Max), then restart the harness.\n` +
        `Subscription-only mode refuses to run on API billing.`,
    );
  }
  return plan;
}

/** Path to the Codex CLI bundled with this project (falls back to one on PATH). */
export function codexBin(root: string): string {
  if (process.env.HARNESS_CODEX_BIN) return process.env.HARNESS_CODEX_BIN;
  const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  return existsSync(local) ? local : "codex";
}

/**
 * Sign Codex in to ChatGPT: runs `codex login`, which opens the browser and
 * waits for the sign-in to finish. Resolves with the new status.
 */
export function codexLogin(root: string, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin(root), ["login"], { env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(codexStatus(root));
    }
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      const st = codexStatus(root);
      // If the browser didn't open, pass on the sign-in link Codex printed.
      const url = out.match(/https:\/\/\S+/)?.[0];
      resolve(st.ok || !url ? st : { ...st, detail: `${st.detail} Sign-in link: ${url}` });
    };
    child.on("exit", done);
    child.on("error", done);
  });
}

/** Codex must be logged in with ChatGPT, not an API key. */
export function codexStatus(root: string): { ok: boolean; detail: string } {
  const r = spawnSync(codexBin(root), ["login", "status"], { env: subscriptionEnv(), encoding: "utf8" });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.error) return { ok: false, detail: "Codex CLI not found; run npm install" };
  if (/chatgpt/i.test(text)) return { ok: true, detail: "ChatGPT subscription" };
  if (/api key/i.test(text)) return { ok: false, detail: "Codex is using an API key; run `npx codex logout` then `npx codex login`" };
  return { ok: false, detail: "Codex not signed in; run `npx codex login` and choose Sign in with ChatGPT" };
}
