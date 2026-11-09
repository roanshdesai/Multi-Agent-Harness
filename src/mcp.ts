import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";

const env = (k: string) => process.env[k] ?? "";

/**
 * External MCP servers. A server is only added when it is enabled in the
 * config AND its credentials are present, so a missing key never breaks startup.
 */
export function buildExternalMcp(cfg: HarnessConfig): {
  servers: Record<string, McpServerConfig>;
  skipped: string[];
} {
  const servers: Record<string, McpServerConfig> = {};
  const skipped: string[] = [];
  const add = (name: string, needs: string[], conf: McpServerConfig) => {
    if (!cfg.mcp[name]) return;
    const missing = needs.filter((k) => !env(k));
    if (missing.length) skipped.push(`${name} (missing ${missing.join(", ")})`);
    else servers[name] = conf;
  };

  add("github", ["GITHUB_TOKEN"], {
    type: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: `Bearer ${env("GITHUB_TOKEN")}` },
  });

  add("slack", ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"], {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: env("SLACK_BOT_TOKEN"), SLACK_TEAM_ID: env("SLACK_TEAM_ID") },
  });

  // Outlook mail + calendar via Microsoft Graph
  add("outlook", [], {
    command: "npx",
    args: ["-y", "@softeria/ms-365-mcp-server"],
    env: {
      ...(env("MS365_MCP_CLIENT_ID") && { MS365_MCP_CLIENT_ID: env("MS365_MCP_CLIENT_ID") }),
      ...(env("MS365_MCP_TENANT_ID") && { MS365_MCP_TENANT_ID: env("MS365_MCP_TENANT_ID") }),
    },
  });

  // Hindsight: .env's HINDSIGHT_MCP_URL, else memory.hindsight_mcp in harness.config.yaml.
  const hindsightUrl = env("HINDSIGHT_MCP_URL") || cfg.memory?.hindsight_mcp || "";
  if (cfg.mcp.hindsight && !hindsightUrl) skipped.push("hindsight (set memory.hindsight_mcp in harness.config.yaml)");
  else if (cfg.mcp.hindsight) servers.hindsight = { type: "http", url: hindsightUrl };

  add("firecrawl", ["FIRECRAWL_API_KEY"], {
    command: "npx",
    args: ["-y", "firecrawl-mcp"],
    env: { FIRECRAWL_API_KEY: env("FIRECRAWL_API_KEY") },
  });

  add("exa", ["EXA_API_KEY"], {
    command: "npx",
    args: ["-y", "exa-mcp-server"],
    env: { EXA_API_KEY: env("EXA_API_KEY") },
  });

  add("context7", [], { command: "npx", args: ["-y", "@upstash/context7-mcp"] });

  add("playwright", [], { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] });

  // Remote servers listed by URL in the config (e.g. `pally: https://agent.pally.com/mcp`).
  // Sign-in, if the server needs it, shows up as "needs auth" in Connections.
  for (const [name, v] of Object.entries(cfg.mcp))
    if (typeof v === "string" && /^https?:\/\//.test(v) && !servers[name]) servers[name] = { type: "http", url: v };

  return { servers, skipped };
}
