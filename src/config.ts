import { readFileSync, existsSync, writeFileSync } from "node:fs";
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
    /** UI and visual design. Falls back to the coder's model when not set. */
    designer?: string;
    gui: string;
    image: string;
    image_fallback: string;
    gpt: string[];
    fallback: string[];
    /** Claude models offered in each tab's picker. Empty: everything your plan offers. */
    claude?: string[];
  };
  effort: Record<"main" | "advisor" | "coder" | "worker" | "verifier", Effort>;
  stuck_after_failures: number;
  verify: { enabled: boolean; max_rounds: number };
  approvals: { github_push: "ask" | "allow" | "deny"; protected_branches: string[] };
  sandbox: { enabled: boolean; fail_if_unavailable: boolean };
  design_library: string;
  plugins_dir: string;
  chats_dir: string;
  /** true/false toggles a built-in server; a URL adds a remote (HTTP) MCP server under that name. */
  mcp: Record<string, boolean | string>;
  auth: { subscription_only: boolean };
  memory: { claude_mem: string[]; hindsight: string[] };
  advisor: { auto: boolean };
  limits: { fallback_to_gpt: boolean; warn_at: number; refresh_minutes?: number };
  subagents_file: string;
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

/** Model roles the app lets you change. */
export const MODEL_ROLES = ["main", "advisor", "coder", "designer", "worker", "triage", "video", "verifier", "gui", "image", "image_fallback"] as const;
export const MODEL_LISTS = ["gpt", "claude", "fallback"] as const;

/**
 * Save model choices back to harness.config.yaml (keeping its comments) and
 * apply them to the running config, so new turns and tabs use them at once.
 */
export function saveModels(cfg: HarnessConfig, changes: Partial<HarnessConfig["models"]>): HarnessConfig["models"] {
  const file = resolve(cfg.root, process.env.HARNESS_CONFIG ?? "harness.config.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(changes)) {
    const role = k as keyof HarnessConfig["models"];
    if ((MODEL_ROLES as readonly string[]).includes(role)) {
      const id = String(v ?? "").trim();
      if (!id) throw new Error(`Pick a model for "${role}".`);
      doc.setIn(["models", role], id);
      (cfg.models as unknown as Record<string, unknown>)[role] = id;
    } else if ((MODEL_LISTS as readonly string[]).includes(role)) {
      const list = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
      if (role === "gpt" && !list.length) throw new Error("Keep at least one GPT model.");
      const node = doc.createNode(list);
      (node as { flow?: boolean }).flow = true;
      doc.setIn(["models", role], node);
      (cfg.models as unknown as Record<string, unknown>)[role] = list;
    }
  }
  writeFileSync(file, doc.toString());
  return cfg.models;
}

export function loadConfig(root = process.env.HARNESS_ROOT ?? process.cwd()): HarnessConfig {
  loadDotEnv(root);
  const file = resolve(root, process.env.HARNESS_CONFIG ?? "harness.config.yaml");
  if (!existsSync(file)) throw new Error(`Config not found: ${file}`);
  const cfg = YAML.parse(expandEnv(readFileSync(file, "utf8"))) as HarnessConfig;
  cfg.root = root;
  cfg.auth ??= { subscription_only: true };
  cfg.models.image ??= cfg.models.gui;
  cfg.models.image_fallback ??= cfg.models.gui;
  cfg.models.gpt ??= [...new Set([cfg.models.gui, cfg.models.image].filter(Boolean))];
  cfg.models.fallback ??= [];
  cfg.memory ??= { claude_mem: [], hindsight: [] };
  cfg.advisor ??= { auto: true };
  cfg.limits ??= { fallback_to_gpt: true, warn_at: 0.8 };
  cfg.subagents_file = resolve(root, cfg.subagents_file ?? "subagents.yaml");
  // Escape hatch for CI/testing machines that only have API credentials.
  if (process.env.HARNESS_ALLOW_API === "1") cfg.auth.subscription_only = false;
  cfg.design_library = resolve(root, cfg.design_library);
  cfg.plugins_dir = resolve(root, cfg.plugins_dir);
  cfg.chats_dir = resolve(root, cfg.chats_dir);
  return cfg;
}
