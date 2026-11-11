import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "./config.js";
import { bankFor, projectFor, loadProjects } from "./projects.js";

/**
 * Self-learning ("instincts"), after ECC's continuous-learning-v2: lessons
 * about how the owner wants work done, learned from their own messages
 * (corrections, stated preferences, fixes that worked, repeated workflows).
 *
 * - Source: Claude Code transcripts (~/.claude/projects) for sessions in the
 *   owner's project folders. The harness's Claude chats are stored there too.
 * - When: a transcript that has gone quiet for `learning.idle_minutes` is read
 *   once per new chunk; one cheap model pass (learning.model) extracts lessons.
 * - Storage: <data folder>/.harness/instincts/<bank>.json per project (the
 *   same bank as Hindsight memory) and global.json. Local only.
 * - Use: the strongest ones (confidence ≥ 0.7, at most 8) go into every new
 *   chat's system prompt for that project.
 */

export interface Instinct {
  id: string;
  /** When it applies, e.g. "when changing the desktop UI". */
  trigger: string;
  /** What to do, e.g. "no gradients, glows or glass; keep it original". */
  action: string;
  /** Short quotes that taught it, newest last. */
  evidence: string[];
  confidence: number;
  scope: "project" | "global";
  /** Hindsight bank id of the project it was learned in. */
  project: string;
  created: number;
  last_seen: number;
  hits: number;
}

/** What one extraction pass reports about a lesson. */
export interface Observation {
  /** new: a lesson not in the list; seen: an existing one came up again; corrected: the owner pushed back on an existing one. */
  kind: "new" | "seen" | "corrected";
  id: string;
  trigger?: string;
  action?: string;
  evidence?: string;
  scope?: "project" | "global";
}

export const START = 0.4;
export const RISE = 0.1;
export const FALL = 0.3;
export const MAX = 0.9;
export const FLOOR = 0.3;
export const INJECT_AT = 0.7;
export const INJECT_MAX = 8;
const MONTH = 30 * 24 * 3600_000;

const DAY = 24 * 3600_000;
const dir = (cfg: HarnessConfig) => join(cfg.root, ".harness", "instincts");
const safe = (bank: string) => bank.replace(/[^A-Za-z0-9._-]+/g, "_");
const fileFor = (cfg: HarnessConfig, bank: string | null) => join(dir(cfg), bank ? `${safe(bank)}.json` : "global.json");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `lesson-${Date.now()}`;

function read(file: string): Instinct[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(file: string, list: Instinct[]) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(list, null, 1));
}

/** Confidence after fading: −0.1 for each full month it hasn't come up. */
export function effective(i: Instinct, now = Date.now()): number {
  const months = Math.floor(Math.max(0, now - i.last_seen) / MONTH);
  return Math.round(Math.max(0, i.confidence - months * 0.1) * 100) / 100;
}

export function loadInstincts(cfg: HarnessConfig, bank: string): { project: Instinct[]; global: Instinct[] } {
  return { project: read(fileFor(cfg, bank)), global: read(fileFor(cfg, null)) };
}

/** Save an edited instinct (from the app), or remove it when `remove` is set. */
export function saveInstinct(cfg: HarnessConfig, bank: string, inst: Instinct, remove = false) {
  for (const b of [bank, null]) {
    const f = fileFor(cfg, b);
    write(f, read(f).filter((x) => x.id !== inst.id));
  }
  if (remove) return;
  const f = fileFor(cfg, inst.scope === "global" ? null : bank);
  const clean: Instinct = { ...inst, confidence: Math.min(MAX, Math.max(0, Number(inst.confidence) || START)), id: inst.id || slug(inst.trigger) };
  write(f, [...read(f), clean]);
}

/**
 * Apply one extraction pass's observations to a project's instincts (and the
 * global ones). Pure apart from the files: rises on `seen`, falls on
 * `corrected`, new ones start at START, anything below FLOOR is dropped.
 */
export function applyObservations(cfg: HarnessConfig, bank: string, obs: Observation[], now = Date.now()): { project: Instinct[]; global: Instinct[] } {
  const store = loadInstincts(cfg, bank);
  const find = (id: string) => store.project.find((x) => x.id === id) ?? store.global.find((x) => x.id === id);
  for (const o of obs) {
    const id = slug(o.id || o.trigger || "");
    const hit = find(id);
    const ev = (o.evidence ?? "").trim().slice(0, 240);
    if (hit) {
      if (o.kind === "corrected") hit.confidence = hit.confidence - FALL;
      else hit.confidence = Math.min(MAX, effective(hit, now) + RISE);
      if (o.kind === "corrected" && o.action) hit.action = o.action; // the correction says what to do instead
      hit.last_seen = now;
      hit.hits++;
      if (ev) hit.evidence = [...hit.evidence, ev].slice(-5);
    } else if (o.kind !== "corrected" && o.trigger && o.action) {
      const inst: Instinct = { id, trigger: o.trigger, action: o.action, evidence: ev ? [ev] : [], confidence: START, scope: o.scope === "global" ? "global" : "project", project: bank, created: now, last_seen: now, hits: 1 };
      (inst.scope === "global" ? store.global : store.project).push(inst);
    }
  }
  store.project = store.project.filter((x) => x.confidence >= FLOOR);
  store.global = store.global.filter((x) => x.confidence >= FLOOR);
  write(fileFor(cfg, bank), store.project);
  write(fileFor(cfg, null), store.global);
  return store;
}

/**
 * A project lesson that shows up in two or more projects at an average
 * confidence of 0.8 or more becomes a global one.
 */
export function promote(cfg: HarnessConfig, now = Date.now()): string[] {
  if (!existsSync(dir(cfg))) return [];
  const files = readdirSync(dir(cfg)).filter((f) => f.endsWith(".json") && f !== "global.json" && f !== "processed.json");
  const byId = new Map<string, { file: string; inst: Instinct }[]>();
  for (const f of files) for (const inst of read(join(dir(cfg), f))) byId.set(inst.id, [...(byId.get(inst.id) ?? []), { file: f, inst }]);
  const global = read(fileFor(cfg, null));
  const promoted: string[] = [];
  for (const [id, list] of byId) {
    if (list.length < 2 || global.some((g) => g.id === id)) continue;
    const avg = list.reduce((n, x) => n + effective(x.inst, now), 0) / list.length;
    if (avg < 0.8) continue;
    const best = list.sort((a, b) => b.inst.confidence - a.inst.confidence)[0].inst;
    global.push({ ...best, scope: "global", confidence: Math.min(MAX, avg), hits: list.reduce((n, x) => n + x.inst.hits, 0), evidence: list.flatMap((x) => x.inst.evidence).slice(-5) });
    for (const { file } of list) {
      const p = join(dir(cfg), file);
      write(p, read(p).filter((x) => x.id !== id));
    }
    promoted.push(id);
  }
  if (promoted.length) write(fileFor(cfg, null), global);
  return promoted;
}

/** The lessons a new chat in `cwd` should follow: confidence ≥ 0.7, best first, at most 8. */
export function strongInstincts(cfg: HarnessConfig, cwd: string, now = Date.now()): Instinct[] {
  const { project, global } = loadInstincts(cfg, bankFor(cfg, cwd));
  return [...project, ...global]
    .map((i) => ({ i, c: effective(i, now) }))
    .filter((x) => x.c >= INJECT_AT)
    .sort((a, b) => b.c - a.c || b.i.hits - a.i.hits)
    .slice(0, INJECT_MAX)
    .map((x) => x.i);
}

/** System-prompt block with the strong lessons, or "" if there are none. */
export function instinctsBlock(cfg: HarnessConfig, cwd: string): string {
  if (cfg.learning?.enabled === false) return "";
  const list = strongInstincts(cfg, cwd);
  if (!list.length) return "";
  return `\n# What you've learned about how the user works\nThese were learned from the user's own corrections and habits. Follow them, and pass the relevant ones on when you brief a subagent. If the user says otherwise now, the user wins.\n${list.map((i) => `- ${i.trigger}: ${i.action}`).join("\n")}\n`;
}

// ── reading transcripts ────────────────────────────────────────────────────

/** Transcript text that isn't the owner talking: notices, reminders, command echoes. */
const NOISE = /^\s*<(task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|user-prompt-submit-hook)/;
const stripTags = (t: string) =>
  t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(hindsight_[a-z_]+|pasted_content)[^>]*>[\s\S]*?<\/\1[^>]*>/g, "[pasted text]")
    .trim();

/**
 * Sessions started by tools rather than the owner (Hindsight's repo survey,
 * the harness's own summaries and checks) open with an instruction to the
 * agent. Their "user" isn't the owner, so there's nothing to learn from them.
 */
export const AUTOMATED = /^\s*(you are (a|an|the|performing)\b|read the document at |you read a conversation between)/i;

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** The conversation in a Claude Code transcript from line `from` on: the owner's words and the agent's replies. */
export async function readTranscript(file: string, from = 0): Promise<{ turns: Turn[]; lines: number; cwd: string | null; automated: boolean }> {
  const turns: Turn[] = [];
  let automated = false;
  let sawUser = false;
  let lines = 0;
  let cwd: string | null = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (!line.startsWith("{") || (lines <= from && sawUser)) continue;
    let o: { type?: string; cwd?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    cwd ??= o.cwd ?? null;
    if ((o.type !== "user" && o.type !== "assistant") || o.isSidechain || o.isMeta) continue;
    const c = o.message?.content;
    const parts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => String(x.text ?? "")) : [];
    for (const p of parts) {
      if (o.type === "user" && !sawUser && !NOISE.test(p)) {
        sawUser = true;
        if (AUTOMATED.test(p)) automated = true; // judged on the session's first real message
      }
      if (lines <= from) continue;
      if (NOISE.test(p)) continue;
      const text = stripTags(p);
      if (text) turns.push({ role: o.type as "user" | "assistant", text: text.slice(0, 2000) });
    }
  }
  return { turns: automated ? [] : turns, lines, cwd, automated };
}

/** The extraction prompt for one chunk of conversation. */
export function extractionPrompt(turns: Turn[], known: Instinct[]): string {
  const convo = turns.map((t) => `${t.role === "user" ? "USER" : "AGENT"}: ${t.text}`).join("\n\n");
  const list = known.length ? known.map((k) => `- ${k.id} [${k.scope}]: ${k.trigger} → ${k.action}`).join("\n") : "(none yet)";
  return `You read a conversation between a developer (USER) and their coding agent (AGENT) and pull out lessons about how this USER wants work done, so future agents get it right without being told.

Look for:
- corrections: the USER told the agent to do something differently, or rejected what it did;
- preferences the USER stated (style, tools, wording, process, what to never do);
- fixes that worked for a problem likely to come back;
- workflows the USER keeps asking for.

Rules:
- Only lessons grounded in the USER's own words. Ignore one-off task details, facts about the code, and anything the AGENT decided on its own.
- One lesson = one trigger and one action, short and concrete ("when building the desktop UI" → "no gradients, glows or glass").
- scope "global" only if it's about the USER in general (git and push rules, writing style); otherwise "project".
- Never include secrets, tokens, passwords, emails or other personal data.
- Known lessons are listed below. If one came up again and the USER was fine with it, report kind "seen" with its id. If the USER pushed back on one, report kind "corrected" with its id and the new action. Otherwise kind "new" with a short kebab-case id.
- If there's nothing worth learning, return an empty list.

Known lessons:
${list}

Conversation:
${convo}`;
}

export const OBSERVATION_SCHEMA = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["new", "seen", "corrected"] },
          id: { type: "string" },
          trigger: { type: "string" },
          action: { type: "string" },
          evidence: { type: "string", description: "A short quote of the USER's words" },
          scope: { type: "string", enum: ["project", "global"] },
        },
        required: ["kind", "id"],
      },
    },
  },
  required: ["lessons"],
} as const;

// ── the learning pass ──────────────────────────────────────────────────────

interface Processed {
  [file: string]: { lines: number; size: number; cwd?: string | null };
}

/** The folder a transcript's session ran in, from its first lines (stops early). */
export async function transcriptCwd(file: string): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 50) break;
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } finally {
    rl.close();
  }
  return null;
}
const processedFile = (cfg: HarnessConfig) => join(dir(cfg), "processed.json");

/** Claude Code transcripts that are quiet, have new lines, and belong to one of the owner's projects. */
export async function pendingTranscripts(cfg: HarnessConfig, now = Date.now()): Promise<{ file: string; from: number; bank: string }[]> {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return [];
  const idle = (cfg.learning?.idle_minutes ?? 3) * 60_000;
  // Older history isn't read: learning starts from recent work, not months of backlog.
  const since = now - (cfg.learning?.since_days ?? 14) * DAY;
  const done: Processed = (() => {
    try {
      return JSON.parse(readFileSync(processedFile(cfg), "utf8"));
    } catch {
      return {};
    }
  })();
  const projects = loadProjects(cfg);
  const out: { file: string; from: number; bank: string }[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(root, d.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(root, d.name, f);
      const st = statSync(file);
      if (now - st.mtimeMs < idle || st.mtimeMs < since) continue; // still being written, or too old
      const prev = done[file];
      if (prev && prev.size === st.size) continue;
      const cwd = prev?.cwd !== undefined ? prev.cwd : await transcriptCwd(file).catch(() => null);
      if (!cwd || !projectFor(projects, cwd)) {
        if (!prev) done[file] = { lines: 0, size: -1, cwd }; // remember the folder so it isn't read again
        continue; // only the owner's projects
      }
      out.push({ file, from: prev?.lines ?? 0, bank: bankFor(cfg, cwd) });
    }
  }
  mkdirSync(dir(cfg), { recursive: true });
  writeFileSync(processedFile(cfg), JSON.stringify(done));
  return out;
}

/** Remember how far a transcript has been read. */
export function markProcessed(cfg: HarnessConfig, file: string, lines: number) {
  const f = processedFile(cfg);
  let done: Processed = {};
  try {
    done = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    /* first run */
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    /* gone */
  }
  done[file] = { ...done[file], lines, size };
  mkdirSync(dir(cfg), { recursive: true });
  writeFileSync(f, JSON.stringify(done));
}

/** Runs one model call and returns the lessons it found (injected so tests don't need a model). */
export type Extractor = (prompt: string) => Promise<Observation[]>;

/**
 * One learning pass: read up to `max` quiet transcripts' new turns and update
 * the instincts. Chunks with no message from the owner are skipped without a
 * model call. Returns a short report.
 */
export async function learn(cfg: HarnessConfig, extract: Extractor, opts: { max?: number; now?: number } = {}): Promise<{ read: number; lessons: number; promoted: string[] }> {
  if (cfg.learning?.enabled === false) return { read: 0, lessons: 0, promoted: [] };
  const now = opts.now ?? Date.now();
  const todo = (await pendingTranscripts(cfg, now)).slice(0, opts.max ?? 5);
  let read = 0;
  let lessons = 0;
  for (const t of todo) {
    const { turns, lines } = await readTranscript(t.file, t.from);
    // Keep the last part of a long chunk; that's where corrections usually are.
    let chunk = turns;
    while (chunk.length > 1 && chunk.reduce((n, x) => n + x.text.length, 0) > 24_000) chunk = chunk.slice(1);
    if (chunk.some((x) => x.role === "user")) {
      const { project, global } = loadInstincts(cfg, t.bank);
      const obs = await extract(extractionPrompt(chunk, [...project, ...global]));
      applyObservations(cfg, t.bank, obs, now);
      lessons += obs.length;
      read++;
    }
    markProcessed(cfg, t.file, lines);
  }
  const promoted = promote(cfg, now);
  return { read, lessons, promoted };
}

