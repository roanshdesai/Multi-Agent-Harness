import { readFileSync, writeFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";

/** A subagent you created with /subagents. Stored in subagents.yaml. */
export interface CustomSubagent {
  name: string;
  description: string;
  /** "claude": runs on a Claude model. "gpt": a Sonnet coordinator hands the work to a GPT model via Codex. */
  engine: "claude" | "gpt";
  model: string;
  prompt: string;
  tools?: string[];
}

export const SUBAGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "subagents"],
  properties: {
    summary: { type: "string", description: "One or two sentences on why this team fits" },
    subagents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "engine", "model", "prompt"],
        properties: {
          name: { type: "string", description: "kebab-case, e.g. seo-writer" },
          description: { type: "string", description: "When the orchestrator should use it (one or two sentences)" },
          engine: { type: "string", enum: ["claude", "gpt"] },
          model: { type: "string" },
          prompt: { type: "string", description: "The subagent's full system prompt" },
          tools: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export function loadSubagents(cfg: HarnessConfig): CustomSubagent[] {
  if (!existsSync(cfg.subagents_file)) return [];
  try {
    const data = YAML.parse(readFileSync(cfg.subagents_file, "utf8"));
    const list = Array.isArray(data) ? data : data?.subagents;
    return Array.isArray(list) ? list.filter((a) => a?.name && a?.prompt).map(normalize) : [];
  } catch {
    return [];
  }
}

export function saveSubagents(cfg: HarnessConfig, list: CustomSubagent[]) {
  const header = "# Your subagents. Made with /subagents; safe to edit by hand.\n";
  writeFileSync(cfg.subagents_file, header + YAML.stringify({ subagents: list.map(normalize) }));
}

export function normalize(a: CustomSubagent): CustomSubagent {
  const name = String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "subagent";
  const engine = a.engine === "gpt" || /^gpt-/i.test(a.model) ? "gpt" : "claude";
  return { name, description: a.description, engine, model: a.model, prompt: a.prompt, ...(a.tools?.length && { tools: a.tools }) };
}

/** Add or replace by name. */
export function upsertSubagents(cfg: HarnessConfig, add: CustomSubagent[]): CustomSubagent[] {
  const byName = new Map(loadSubagents(cfg).map((a) => [a.name, a]));
  for (const a of add.map(normalize)) byName.set(a.name, a);
  const list = [...byName.values()];
  saveSubagents(cfg, list);
  return list;
}

export function removeSubagent(cfg: HarnessConfig, name: string): boolean {
  const list = loadSubagents(cfg);
  const next = list.filter((a) => a.name !== name);
  if (next.length === list.length) return false;
  saveSubagents(cfg, next);
  return true;
}

/** Turn a custom subagent into an SDK agent definition. */
export function toAgentDefinition(a: CustomSubagent, cfg: HarnessConfig): AgentDefinition {
  if (a.engine === "gpt") {
    return {
      description: `${a.description} (runs on ${a.model})`,
      model: cfg.models.worker,
      effort: "low",
      prompt: `You coordinate a specialist that runs on ${a.model}.
For every task: gather the context it needs (read the relevant files yourself), then call mcp__harness__ask_gpt with model "${a.model}" and a complete, self-contained prompt. GPT cannot see this conversation.
Return its answer. If it is clearly wrong or incomplete, ask it once more with corrections.

The specialist's instructions:
${a.prompt}`,
    };
  }
  return { description: a.description, model: a.model, prompt: a.prompt, ...(a.tools?.length && { tools: a.tools }) };
}

/** The prompt that asks the Fable advisor to design subagents. */
export function designPrompt(request: string, existing: { name: string; description: string }[], cfg: HarnessConfig): string {
  const claudeModels = [cfg.models.main, cfg.models.advisor, cfg.models.worker].filter((m, i, a) => a.indexOf(m) === i);
  return `You are designing subagents for the user's multi-model agent harness. Each subagent is a specialist the orchestrator (${cfg.models.main}) can delegate to.

${request.trim() ? `The user asked for:\n"""${request.trim()}"""\nDesign exactly what they asked for. Fill gaps sensibly.` : `The user did not say what they need. Look at the project in the current folder (README, package files, folder layout, recent work) and propose the 2 to 4 subagents that would help most with THIS project. Do not duplicate the existing team.`}

Existing team (don't recreate these unless asked):
${existing.map((e) => `- ${e.name}: ${e.description}`).join("\n")}

Models you may use:
- Claude (engine "claude"): ${claudeModels.join(", ")}. Use ${cfg.models.advisor} for hard reasoning and coding, ${cfg.models.worker} for reading-heavy and routine work.
- GPT via the user's ChatGPT plan (engine "gpt"): ${cfg.models.gpt.join(", ")}. Use only when GPT is a better fit or the user asks for it.

For each subagent write a sharp, specific system prompt: what it owns, how it works, what it returns, and what it must not do. Names are short kebab-case. Leave tools empty unless the agent must be restricted.`;
}
