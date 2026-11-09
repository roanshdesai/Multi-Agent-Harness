import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface HarnessConfig {
  models: {
    main: string;
    advisor: string;
    coder: string;
    worker: string;
    triage: string;
    video: string;
    verifier: string;
    gui: string;
    fallback: string[];
  };
  effort: Record<"main" | "advisor" | "coder" | "worker" | "verifier", Effort>;
  stuck_after_failures: number;
  verify: { enabled: boolean; max_rounds: number };
  approvals: { github_push: "ask" | "allow" | "deny"; protected_branches: string[] };
  sandbox: { enabled: boolean; fail_if_unavailable: boolean };
  design_library: string;
  plugins_dir: string;
  chats_dir: string;
  mcp: Record<string, boolean>;
  auth: { subscription_only: boolean };
  root: string;
}

function expandEnv(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

/** Minimal .env loader so the app has no extra dependency for it. */
export function loadDotEnv(root: string): void {
  const file = resolve(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function loadConfig(root = process.env.HARNESS_ROOT ?? process.cwd()): HarnessConfig {
  loadDotEnv(root);
  const file = resolve(root, process.env.HARNESS_CONFIG ?? "harness.config.yaml");
  if (!existsSync(file)) throw new Error(`Config not found: ${file}`);
  const cfg = YAML.parse(expandEnv(readFileSync(file, "utf8"))) as HarnessConfig;
  cfg.root = root;
  cfg.auth ??= { subscription_only: true };
  // Escape hatch for CI/testing machines that only have API credentials.
  if (process.env.HARNESS_ALLOW_API === "1") cfg.auth.subscription_only = false;
  cfg.design_library = resolve(root, cfg.design_library);
  cfg.plugins_dir = resolve(root, cfg.plugins_dir);
  cfg.chats_dir = resolve(root, cfg.chats_dir);
  return cfg;
}
