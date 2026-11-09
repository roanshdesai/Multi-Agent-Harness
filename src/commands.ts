import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";

export type CommandGroup = "Chat" | "Team" | "Memory" | "Harness" | "Skills & plugins" | "Claude Code";

export interface CommandInfo {
  name: string; // with leading slash
  args?: string;
  description: string;
  group: CommandGroup;
  aliases?: string[];
}

/** The harness's own commands. Both the terminal and the desktop app implement every one of these. */
export const HARNESS_COMMANDS: CommandInfo[] = [
  { name: "/new", description: "Start a new chat", group: "Chat", aliases: ["/clear"] },
  { name: "/fork", args: "[title]", description: "Copy this chat into a new window (terminal: add --here to stay)", group: "Chat" },
  { name: "/btw", args: "<question>", description: "Side question that doesn't touch the chat; works mid-turn", group: "Chat" },
  { name: "/chats", description: "List recent chats", group: "Chat" },
  { name: "/resume", args: "<id | #>", description: "Reopen a chat", group: "Chat" },
  { name: "/rename", args: "<title>", description: "Rename this chat", group: "Chat" },
  { name: "/compact", description: "Summarize the chat so far to free up context", group: "Chat" },
  { name: "/stop", description: "Stop the running turn (and its verifier)", group: "Chat" },
  { name: "/tabs", description: "List open tabs (terminal linked to the app; in the app, use the tab bar)", group: "Chat" },
  { name: "/tab", args: "<n>", description: "Switch tab (terminal linked to the app; in the app, ⌘1–9)", group: "Chat" },
  { name: "/detach", description: "Stop sharing tabs with the app (terminal only)", group: "Chat" },

  { name: "/advisor", args: "<question>", description: "Ask the Fable advisor", group: "Team" },
  { name: "/code", args: "<task>", description: "Hand a coding task to the Fable coder", group: "Team" },
  { name: "/research", args: "<question>", description: "Send Sonnet researchers", group: "Team" },
  { name: "/test", args: "<url> <checklist>", description: "GUI test with GPT-6 Astra (via Codex)", group: "Team" },
  { name: "/image", args: "<what to make or check>", description: "Images on GPT-6.1 Sol: generate, edit, review screenshots", group: "Team" },
  { name: "/video", args: "<task>", description: "Video task for Opus", group: "Team" },
  { name: "/subagents", args: "[describe | suggest | remove <name>]", description: "Make your own subagents; empty = the advisor suggests some", group: "Team" },
  { name: "/design", args: "[query]", description: "Search your UI links (add 'swift' for SwiftUI)", group: "Team" },

  { name: "/remember", args: "<fact>", description: "Save to long-term memory (Hindsight)", group: "Memory" },
  { name: "/recall", args: "<question>", description: "Search long-term memory (Hindsight + claude-mem)", group: "Memory" },

  { name: "/agents", description: "Show the team and their models", group: "Harness" },
  { name: "/status", description: "Plans, models, integrations, plugins", group: "Harness" },
  { name: "/model", args: "[id]", description: "Change this tab's model, Claude or GPT", group: "Harness" },
  { name: "/verify", args: "on | off", description: "Turn the Fable verifier on or off", group: "Harness" },
  { name: "/eval", args: "[filter]", description: "Run the eval suite", group: "Harness" },
  { name: "/help", description: "All commands, including skills and plugins", group: "Harness" },
  { name: "/exit", description: "Quit (desktop: close this window)", group: "Harness", aliases: ["/quit"] },
];

/** Claude Code built-ins that are useful through the harness (everything else needs the full CLI UI). */
const USEFUL_BUILTINS = new Set(["context", "usage", "cost", "init", "review", "security-review", "pr-comments", "todos", "memory"]);

/**
 * Merge the harness commands with what the session reports: plugin and skill
 * commands (Superpowers, gstack, taste-skill, claude-mem...) and a few useful built-ins.
 * Harness commands win on name clashes.
 */
export function mergeCommands(session: SlashCommand[]): CommandInfo[] {
  const taken = new Set(HARNESS_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const extra: CommandInfo[] = [];
  for (const s of session) {
    const name = `/${s.name}`;
    if (taken.has(name)) continue;
    if (s.builtin && !USEFUL_BUILTINS.has(s.name)) continue;
    taken.add(name);
    extra.push({
      name,
      args: s.argumentHint || undefined,
      description: (s.description || "").replace(/\s+/g, " ").slice(0, 140),
      group: s.builtin ? "Claude Code" : "Skills & plugins",
    });
  }
  extra.sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group === "Skills & plugins" ? -1 : 1));
  return [...HARNESS_COMMANDS, ...extra];
}

export function canonical(cmd: string): string {
  const hit = HARNESS_COMMANDS.find((c) => c.aliases?.includes(cmd));
  return hit ? hit.name : cmd;
}
