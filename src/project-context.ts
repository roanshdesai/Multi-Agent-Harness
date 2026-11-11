import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "./config.js";
import { bankFor } from "./projects.js";

/**
 * Project context, like a Claude project's files and links: things the owner
 * pins to a project so every chat there knows about them. Kept per project
 * (same key as its Hindsight bank) under .harness/context/. Files are
 * referenced by path, not copied.
 */
export interface ProjectContext {
  files: string[];
  links: { url: string; title?: string }[];
}

const file = (cfg: HarnessConfig, cwd: string) => join(cfg.root, ".harness", "context", `${bankFor(cfg, cwd).replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);

export function loadContext(cfg: HarnessConfig, cwd: string): ProjectContext {
  try {
    const v = JSON.parse(readFileSync(file(cfg, cwd), "utf8")) as Partial<ProjectContext>;
    return { files: Array.isArray(v.files) ? v.files.filter((f) => typeof f === "string") : [], links: Array.isArray(v.links) ? v.links.filter((l) => l && typeof l.url === "string") : [] };
  } catch {
    return { files: [], links: [] };
  }
}

export function saveContext(cfg: HarnessConfig, cwd: string, ctx: ProjectContext): ProjectContext {
  const clean: ProjectContext = {
    files: [...new Set((ctx.files ?? []).filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()))].slice(0, 100),
    links: (ctx.links ?? [])
      .map((l) => ({ url: String(l.url ?? "").trim(), ...(l.title?.trim() && { title: l.title.trim() }) }))
      .filter((l) => /^https?:\/\/\S+$/i.test(l.url))
      .filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i)
      .slice(0, 100),
  };
  const f = file(cfg, cwd);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(clean, null, 1));
  return clean;
}

/** System-prompt block listing the project's pinned files and links, or "" if there are none. */
export function contextBlock(cfg: HarnessConfig, cwd: string): string {
  const ctx = loadContext(cfg, cwd);
  const files = ctx.files.filter((f) => existsSync(f));
  if (!files.length && !ctx.links.length) return "";
  const parts = ["\n# Project context the user pinned", "The user pinned these to this project. Open the ones that bear on the request (Read for files, WebFetch for links) before answering, and pass the relevant ones on when you brief a subagent."];
  if (files.length) parts.push("Files:", ...files.map((f) => `- ${f}`));
  if (ctx.links.length) parts.push("Links:", ...ctx.links.map((l) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`));
  return parts.join("\n") + "\n";
}
