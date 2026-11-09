import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import YAML from "yaml";
import type { HarnessConfig } from "./config.js";

/**
 * Projects: named folders in groups (e.g. Kee Makr → Kee → Meta Ray-Bans), kept
 * in <data folder>/projects.yaml. Nothing moves on disk; a project only points
 * at a folder. Each project has its own Hindsight memory bank, so agents
 * working in one project never see another project's memory.
 */

export interface Project {
  name: string;
  /** The folder agents work in (~ allowed). */
  path: string;
  /** Hindsight bank id. Default: the one Hindsight's coding-agent plugin uses for the folder. */
  bank?: string;
  children?: Project[];
}
export interface ProjectGroup {
  name: string;
  projects: Project[];
}
export interface ProjectsFile {
  groups: ProjectGroup[];
}

export const projectsFile = (cfg: HarnessConfig) => join(cfg.root, "projects.yaml");

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function clean(p: Project): Project {
  const out: Project = { name: String(p.name ?? "").trim() || basename(String(p.path ?? "")), path: resolve(expandHome(String(p.path ?? ""))) };
  if (p.bank && String(p.bank).trim()) out.bank = String(p.bank).trim();
  if (Array.isArray(p.children) && p.children.length) out.children = p.children.map(clean);
  return out;
}

export function loadProjects(cfg: HarnessConfig): ProjectsFile {
  try {
    const raw = YAML.parse(readFileSync(projectsFile(cfg), "utf8")) as Partial<ProjectsFile> | null;
    const groups = Array.isArray(raw?.groups) ? raw!.groups : [];
    return { groups: groups.map((g) => ({ name: String(g?.name ?? "").trim() || "Projects", projects: (Array.isArray(g?.projects) ? g.projects : []).map(clean) })) };
  } catch {
    return { groups: [] };
  }
}

export function saveProjects(cfg: HarnessConfig, data: ProjectsFile): ProjectsFile {
  const tidy: ProjectsFile = { groups: (data.groups ?? []).map((g) => ({ name: String(g.name ?? "").trim() || "Projects", projects: (g.projects ?? []).map(clean) })) };
  const home = homedir();
  // Store paths with ~ so the file reads naturally and survives a renamed home folder.
  const short = (p: Project): Project => ({
    ...p,
    path: p.path === home ? "~" : p.path.startsWith(home + sep) ? `~/${p.path.slice(home.length + 1)}` : p.path,
    ...(p.children && { children: p.children.map(short) }),
  });
  mkdirSync(dirname(projectsFile(cfg)), { recursive: true });
  writeFileSync(projectsFile(cfg), "# Projects in the sidebar. Each one has its own Hindsight memory bank.\n" + YAML.stringify({ groups: tidy.groups.map((g) => ({ ...g, projects: g.projects.map(short) })) }));
  return tidy;
}

/** Every project, children included, with the names of its group and parents. */
export function flattenProjects(data: ProjectsFile): { project: Project; trail: string[] }[] {
  const out: { project: Project; trail: string[] }[] = [];
  const walk = (p: Project, trail: string[]) => {
    out.push({ project: p, trail });
    for (const c of p.children ?? []) walk(c, [...trail, p.name]);
  };
  for (const g of data.groups) for (const p of g.projects) walk(p, [g.name]);
  return out;
}

/**
 * The bank Hindsight's coding-agent plugin (what Claude Code uses on this Mac)
 * gives a folder: coding-agent::<repo name>, where a git worktree counts as its
 * main repo. Using the same name means the harness and Claude Code share one
 * memory per project.
 */
export function defaultBank(dir: string): string {
  // The plugin's own routing (mapPathToBank in ~/.hindsight/coding-agent.json) wins, longest path first.
  const d = resolve(dir);
  const mapped = Object.entries(pluginBankMap())
    .filter(([p]) => d === p || d.startsWith(p + sep))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (mapped) return mapped[1];
  let name = basename(dir);
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 5000 });
    const common = r.status === 0 ? r.stdout.trim() : "";
    if (common) name = basename(basename(common) === ".git" ? dirname(common) : common.replace(/\.git$/, ""));
  } catch {
    /* not a repo: the folder name */
  }
  return `coding-agent::${name}`;
}

/** mapPathToBank from Hindsight's coding-agent config (HINDSIGHT_CONFIG moves the file). */
function pluginBankMap(): Record<string, string> {
  try {
    const file = process.env.HINDSIGHT_CONFIG ?? join(homedir(), ".hindsight", "coding-agent.json");
    const m = (JSON.parse(readFileSync(file, "utf8")) as { mapPathToBank?: Record<string, string> }).mapPathToBank ?? {};
    return Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [resolve(expandHome(k)), v]));
  } catch {
    return {};
  }
}

/** The project a folder belongs to: the deepest project whose folder holds it. */
export function projectFor(data: ProjectsFile, dir: string): Project | null {
  const d = resolve(dir);
  let best: Project | null = null;
  for (const { project } of flattenProjects(data)) {
    if ((d === project.path || d.startsWith(project.path + sep)) && (!best || project.path.length > best.path.length)) best = project;
  }
  return best;
}

/** Hindsight bank for work in `dir`: its project's bank, or the folder's own. */
export function bankFor(cfg: HarnessConfig, dir: string): string {
  const p = projectFor(loadProjects(cfg), dir);
  return p ? (p.bank ?? defaultBank(p.path)) : defaultBank(dir);
}

/**
 * Hindsight's single-bank MCP address (…/mcp/<bank>/): an agent connected
 * there can only read and write that one bank.
 */
export function bankMcpUrl(base: string, bank: string): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(bank)}/`;
}

/** Hindsight's web page for one bank, from its UI address. */
export function bankPageUrl(ui: string, bank: string): string {
  return `${ui.replace(/\/+$/, "")}/banks/${encodeURIComponent(bank)}`;
}

/** Whether each project's folder still exists (shown greyed out in the sidebar if not). */
export const folderExists = (p: string) => existsSync(p);
