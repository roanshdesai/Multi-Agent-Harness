import { spawn, type ChildProcess } from "node:child_process";
import { codexBin, subscriptionEnv } from "./subscription.js";

/** One event from `codex exec --json` (fields vary by item type, so kept loose). */
export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; command?: string; query?: string; server?: string; tool?: string; status?: string; aggregated_output?: string; changes?: { path: string; kind?: string }[] };
  error?: { message?: string } | string;
  message?: string;
}

export interface CodexRun {
  child: ChildProcess;
  done: Promise<{ threadId?: string; text: string; ok: boolean; error?: string }>;
}

export interface CodexOptions {
  root: string;
  model: string;
  prompt: string;
  cwd: string;
  resume?: string;
  images?: string[];
  sandbox?: "read-only" | "workspace-write";
  ephemeral?: boolean;
  onEvent?: (e: CodexEvent) => void;
}

/**
 * Run one Codex turn on the ChatGPT subscription (API keys are stripped).
 * Uses --json so callers get live progress events.
 */
export function runCodex(o: CodexOptions): CodexRun {
  const common = [
    "--json",
    "-m", o.model,
    "--skip-git-repo-check",
    "-c", 'approval_policy="never"',
    "-c", `sandbox_mode="${o.sandbox ?? "workspace-write"}"`,
    ...(o.ephemeral ? ["--ephemeral"] : []),
    ...(o.images ?? []).flatMap((i) => ["-i", i]),
  ];
  const args = o.resume ? ["exec", "resume", ...common, o.resume, o.prompt] : ["exec", ...common, o.prompt];
  const child = spawn(codexBin(o.root), args, { cwd: o.cwd, env: subscriptionEnv(), stdio: ["ignore", "pipe", "pipe"] });

  const done = new Promise<{ threadId?: string; text: string; ok: boolean; error?: string }>((resolve) => {
    let threadId = o.resume;
    let text = "";
    let error: string | undefined;
    let buf = "";
    let stderr = "";
    child.stdout!.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let e: CodexEvent;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "thread.started" && e.thread_id) threadId = e.thread_id;
        if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) text = e.item.text;
        if (e.type === "turn.failed" || e.type === "error") {
          error = typeof e.error === "string" ? e.error : (e.error?.message ?? e.message ?? "Codex turn failed");
        }
        o.onEvent?.(e);
      }
    });
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ threadId, text, ok: false, error: err.message }));
    child.on("close", (code) =>
      resolve({ threadId, text, ok: code === 0 && !error, error: error ?? (code !== 0 ? stderr.trim().slice(-800) || `codex exited ${code}` : undefined) }),
    );
  });
  return { child, done };
}
