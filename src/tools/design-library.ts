import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface DesignLink {
  title: string;
  url: string;
  section?: string;
  tags?: string[];
  notes?: string;
  /** Only relevant when building with Swift/SwiftUI. */
  swiftOnly?: boolean;
}

export type Platform = "web" | "swift" | "any";

const SWIFT_ONLY = /only use if building with swift/i;
const STOP = new Set(["and", "the", "for", "with", "use", "only", "if", "building", "repos", "github", "&"]);

/**
 * Parse a Markdown links file:
 *   ## Section heading (only use if building with swift)
 *   - [Title](https://url): notes
 * Section words become tags; "only use if building with swift" marks entries Swift-only.
 */
export function parseMarkdownLinks(md: string): DesignLink[] {
  const links: DesignLink[] = [];
  let section = "";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const h = line.match(/^#{2,6}\s+(.+)$/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    const m = line.match(/^[-*]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*[:\-–—]?\s*(.*)$/) ?? line.match(/^[-*]\s+(https?:\/\/\S+)\s*[:\-–—]?\s*(.*)$/);
    if (!m) continue;
    const [title, url, notes] = m.length === 4 ? [m[1], m[2], m[3]] : [m[1], m[1], m[2]];
    const sectionName = section.replace(/\(.*?\)/g, "").trim();
    const tags = [
      ...new Set(
        sectionName
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 1 && !STOP.has(w)),
      ),
    ];
    const swiftOnly = SWIFT_ONLY.test(section);
    if (swiftOnly) tags.push("swift", "swiftui", "ios");
    links.push({ title, url, section: sectionName || undefined, tags, notes: notes || undefined, swiftOnly });
  }
  return links;
}

export function loadDesignLinks(path: string): DesignLink[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (/\.(md|markdown)$/i.test(path) || /^\s*[-*]\s+\[[^\]]+\]\(https?:/m.test(raw)) return parseMarkdownLinks(raw);
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

/** Swift-only references are hidden unless the work is Swift (or the query says so). */
export function filterByPlatform(links: DesignLink[], platform: Platform, query = ""): DesignLink[] {
  const wantsSwift = platform === "swift" || /\b(swift|swiftui|ios|uikit|xcode)\b/i.test(query);
  if (platform === "any") return links;
  return links.filter((l) => (wantsSwift ? true : !l.swiftOnly));
}

export function searchDesignLinks(links: DesignLink[], query: string, limit = 10): DesignLink[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return links.slice(0, limit);
  return links
    .map((l) => {
      const hay = [l.title, l.url, l.section ?? "", l.notes ?? "", ...(l.tags ?? [])].join(" ").toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0) + (l.tags?.includes(t) ? 2 : 0), 0);
      return { l, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.l);
}

export function formatLink(h: DesignLink): string {
  return `- ${h.title}: ${h.url}${h.section ? ` [${h.section}${h.swiftOnly ? ", Swift only" : ""}]` : ""}${h.notes ? `\n  ${h.notes}` : ""}`;
}

export function designLibraryTool(path: string) {
  return tool(
    "design_library",
    "Search the user's curated UI links library (component sites, animation libraries, GitHub repos, design systems, AI design skills). Call before any UI, frontend, landing page or visual design work, and build with the returned references. Set platform to 'swift' for SwiftUI/iOS work; Swift-only references are hidden otherwise.",
    {
      query: z.string().describe("Keywords, e.g. 'animated components', 'smooth scroll', 'toast', 'design system'"),
      platform: z.enum(["web", "swift", "any"]).optional().describe("Default 'web'"),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ query, platform, limit }) => {
      const all = filterByPlatform(loadDesignLinks(path), platform ?? "web", query);
      const hits = searchDesignLinks(all, query, limit ?? 10);
      const body = hits.length
        ? hits.map(formatLink).join("\n")
        : all.length
          ? `No direct match for "${query}". Full ${platform === "swift" ? "" : "web "}library (${all.length}):\n` + all.map(formatLink).join("\n")
          : `The design library at ${path} is empty.`;
      return { content: [{ type: "text", text: body }] };
    },
  );
}
