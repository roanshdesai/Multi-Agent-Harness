import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join, relative, extname, basename, resolve, sep } from "node:path";
import type { HarnessConfig } from "./config.js";
import type { Harness } from "./session.js";

/** A document in the workspace (or one the agents opened or edited). */
export interface DocInfo {
  path: string;
  rel: string;
  name: string;
  ext: string;
  mtime: number;
  size: number;
  prd: boolean;
  touched?: "read" | "edited";
}

export interface DocSummary {
  tldr: string;
  points: string[];
  requirements: string[];
  open_questions: string[];
  at: number;
  model: string;
}

const DOC_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".pdf", ".docx", ".html", ".csv"]);
const TEXT_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".csv", ".html"]);
const SKIP = new Set(["node_modules", ".git", "dist", "build", "release", "vendor", "out", ".next", ".harness", "coverage", ".venv", "__pycache__"]);
const PRD_NAME = /(^|[^a-z])(prd|prds|requirements?|spec|specs|product[-_ ]?brief)([^a-z]|$)/i;
const PRD_TEXT = /product requirements|requirements document|\bPRD\b|user stories|acceptance criteria|success metrics/i;

function head(path: string, bytes = 4096): string {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  }
}

export function isPrd(path: string): boolean {
  if (PRD_NAME.test(basename(path))) return true;
  return TEXT_EXT.has(extname(path).toLowerCase()) && PRD_TEXT.test(head(path));
}

/** Documents under `cwd` (depth 4), plus files agents touched. Touched first, then newest. */
export function listDocs(cwd: string, touched: Map<string, "read" | "edited"> = new Map(), limit = 300): DocInfo[] {
  const found = new Map<string, DocInfo>();
  const add = (p: string, t?: "read" | "edited") => {
    try {
      const st = statSync(p);
      if (!st.isFile()) return;
      found.set(p, {
        path: p,
        rel: relative(cwd, p) || basename(p),
        name: basename(p),
        ext: extname(p).toLowerCase(),
        mtime: st.mtimeMs,
        size: st.size,
        prd: isPrd(p),
        ...(t && { touched: t }),
      });
    } catch {
      /* gone */
    }
  };
  const walk = (dir: string, depth: number) => {
    if (found.size >= limit * 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && !SKIP.has(e.name)) walk(p, depth - 1);
      } else if (DOC_EXT.has(extname(e.name).toLowerCase())) add(p);
    }
  };
  walk(cwd, 4);
  for (const [p, t] of touched) if (DOC_EXT.has(extname(p).toLowerCase()) || t === "edited") add(p, t);
  return [...found.values()]
    .sort((a, b) => (b.touched ? 1 : 0) - (a.touched ? 1 : 0) || Number(b.prd) - Number(a.prd) || b.mtime - a.mtime)
    .slice(0, limit);
}

/** Only files inside the workspace or the harness folder can be opened. */
export function safePath(p: string, roots: string[]): string {
  let abs: string;
  try {
    abs = realpathSync(resolve(p)); // follow symlinks so a link can't point outside the project
  } catch {
    throw new Error("That file doesn't exist.");
  }
  const inside = roots.some((r) => {
    let root: string;
    try {
      root = realpathSync(resolve(r));
    } catch {
      return false;
    }
    return abs === root || abs.startsWith(root + sep);
  });
  if (!inside) throw new Error("That file is outside the project folder.");
  if (!DOC_EXT.has(extname(abs).toLowerCase())) throw new Error("Only documents (.md, .txt, .pdf, .docx…) can be opened here.");
  return abs;
}

export function readDoc(p: string, roots: string[]): { path: string; text: string | null; ext: string; size: number; prd: boolean } {
  const abs = safePath(p, roots);
  const st = statSync(abs);
  const ext = extname(abs).toLowerCase();
  const text = st.size <= 2_000_000 && !(ext === ".pdf" || ext === ".docx") ? readFileSync(abs, "utf8") : null;
  return { path: abs, text, ext, size: st.size, prd: isPrd(abs) };
}

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tldr", "points", "requirements", "open_questions"],
  properties: {
    tldr: { type: "string", description: "One or two sentences: what this is and what it decides" },
    points: { type: "array", items: { type: "string" }, description: "The main points, most important first (3-8)" },
    requirements: { type: "array", items: { type: "string" }, description: "Must-haves, scope, constraints, success metrics (empty if none)" },
    open_questions: { type: "array", items: { type: "string" }, description: "Gaps, risks, undecided items (empty if none)" },
  },
} as const;

const cacheFile = (cfg: HarnessConfig) => join(cfg.root, ".harness", "summaries.json");

function loadCache(cfg: HarnessConfig): Record<string, DocSummary & { mtime: number }> {
  try {
    return JSON.parse(readFileSync(cacheFile(cfg), "utf8"));
  } catch {
    return {};
  }
}

export function cachedSummary(cfg: HarnessConfig, path: string): DocSummary | null {
  const c = loadCache(cfg)[path];
  try {
    return c && c.mtime === statSync(path).mtimeMs ? c : null;
  } catch {
    return null;
  }
}

/** Summarize a document into its main points (Sonnet, read-only). Cached until the file changes. */
export async function summarizeDoc(harness: Harness, path: string, roots: string[], force = false): Promise<DocSummary> {
  const abs = safePath(path, roots);
  const cfg = harness.cfg;
  if (!force) {
    const hit = cachedSummary(cfg, abs);
    if (hit) return hit;
  }
  const prd = isPrd(abs);
  const r = await harness.run(
    `Read the document at ${abs} in full and summarize it for someone who needs to act on it.${prd ? " It is a PRD (product requirements document): pull out the problem, goals, scope, requirements, success metrics and open questions." : ""}
Use the Read tool. If Read can't open it (for example a .docx), convert it to text with Bash (textutil -convert txt -stdout on macOS, or pandoc) and read that.
Be concrete and faithful to the document; don't invent anything that isn't there.`,
    {
      model: cfg.models.triage,
      effort: "low",
      persistSession: false,
      agents: {},
      tools: ["Read", "Bash", "Glob"],
      outputFormat: { type: "json_schema", schema: SUMMARY_SCHEMA as unknown as Record<string, unknown> },
      maxTurns: 10,
    },
  );
  const out = r.structured as Omit<DocSummary, "at" | "model"> | undefined;
  if (!out?.tldr) throw new Error(r.isError ? r.text : "Couldn't summarize this document.");
  const summary: DocSummary = { ...out, at: Date.now(), model: cfg.models.triage };
  const cache = loadCache(cfg);
  cache[abs] = { ...summary, mtime: statSync(abs).mtimeMs };
  mkdirSync(join(cfg.root, ".harness"), { recursive: true });
  writeFileSync(cacheFile(cfg), JSON.stringify(cache, null, 1));
  return summary;
}

export const exists = existsSync;
