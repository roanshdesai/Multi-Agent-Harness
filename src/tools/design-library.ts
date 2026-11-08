import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface DesignLink {
  title: string;
  url: string;
  tags?: string[];
  notes?: string;
}

export function loadDesignLinks(path: string): DesignLink[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  // Accept YAML/JSON ({links: [...]} or a bare list) or a plain list of URLs.
  try {
    const parsed = YAML.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.links;
    if (Array.isArray(list)) {
      return list.map((e: any) => (typeof e === "string" ? { title: e, url: e } : e));
    }
  } catch {
    /* fall through to line parsing */
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((url) => ({ title: url, url }));
}

export function searchDesignLinks(links: DesignLink[], query: string, limit = 10): DesignLink[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return links.slice(0, limit);
  return links
    .map((l) => {
      const hay = [l.title, l.url, l.notes ?? "", ...(l.tags ?? [])].join(" ").toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0) + (l.tags?.includes(t) ? 2 : 0), 0);
      return { l, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.l);
}

export function designLibraryTool(path: string) {
  return tool(
    "design_library",
    "Search the user's curated design links library. Call before any UI, frontend, landing page, deck or visual design work, and follow the returned references.",
    {
      query: z.string().describe("Keywords or tags, e.g. 'dashboard dark minimal'"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ query, limit }) => {
      const links = loadDesignLinks(path);
      const hits = searchDesignLinks(links, query, limit ?? 10);
      const body = hits.length
        ? hits.map((h) => `- ${h.title} — ${h.url}${h.tags?.length ? ` [${h.tags.join(", ")}]` : ""}${h.notes ? `\n  ${h.notes}` : ""}`).join("\n")
        : links.length
          ? `No match for "${query}". All ${links.length} references:\n` + links.map((h) => `- ${h.title} — ${h.url}`).join("\n")
          : `The design library at ${path} is empty.`;
      return { content: [{ type: "text", text: body }] };
    },
  );
}
