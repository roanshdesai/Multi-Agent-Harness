import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { pipeline } from "node:stream";
import * as zlib from "node:zlib";

/**
 * Token usage over time, like Claude Code's /stats: read from the transcripts
 * Claude Code and Codex already keep on this computer. Nothing is sent anywhere.
 *
 * - Claude: ~/.claude/projects/**\/*.jsonl (or $CLAUDE_CONFIG_DIR), one usage
 *   block per assistant message (deduplicated by message id).
 * - ChatGPT: ~/.codex/sessions/**\/*.jsonl (or $CODEX_HOME), one token_count
 *   event per turn. Codex compresses older rollouts to .jsonl.zst; those are
 *   read too (zstd needs Node 22.15+/Electron 36+, otherwise they're skipped).
 *
 * Tokens counted = input + cache writes + output. Cache reads are left out:
 * they re-read the same context every turn and would swamp the real work.
 */

export type Kind = "claude" | "gpt";
/** day (YYYY-MM-DD, local time) → model → tokens */
type DayModel = Record<string, Record<string, number>>;

interface FileEntry {
  mtimeMs: number;
  size: number;
  kind: Kind;
  days: DayModel;
  session: boolean;
}

export interface TokenStats {
  /** day → kind → model → tokens */
  days: Record<string, Partial<Record<Kind, Record<string, number>>>>;
  sessions: Record<Kind, number>;
  generatedAt: number;
  sources: Record<Kind, string>;
}

const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const codexRoot = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

function dayOf(ts: unknown): string | null {
  const d = new Date(typeof ts === "number" ? ts : String(ts ?? ""));
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function* jsonlFiles(dir: string, depth = 6): Generator<string> {
  if (depth < 0 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p, depth - 1);
    else if (e.name.endsWith(".jsonl") || (e.name.endsWith(".jsonl.zst") && zstd)) yield p;
  }
}

const add = (days: DayModel, day: string, model: string, n: number) => {
  if (!n) return;
  const m = (days[day] ??= {});
  m[model] = (m[model] ?? 0) + n;
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** zstd decompression, when this Node has it (Codex writes .jsonl.zst rollouts). */
const zstd = (zlib as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;

async function readLines(file: string, fn: (o: any) => void) {
  const raw = createReadStream(file);
  // pipeline passes a read or decompression error on to the last stream, so the caller's catch sees it.
  const input = file.endsWith(".zst") && zstd ? (pipeline(raw, zstd(), () => {}) as NodeJS.ReadableStream) : raw;
  input.setEncoding("utf8");
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      fn(JSON.parse(line));
    } catch {
      /* partial or unrelated line */
    }
  }
}

/** One Claude Code transcript. */
export async function readClaudeFile(file: string): Promise<{ days: DayModel; session: boolean }> {
  const byMsg = new Map<string, { day: string; model: string; n: number }>();
  let anon = 0;
  let session = false;
  await readLines(file, (o) => {
    if (o?.type !== "assistant" || !o.message?.usage) return;
    const u = o.message.usage;
    const day = dayOf(o.timestamp);
    const model = String(o.message.model ?? "claude");
    if (!day || model === "<synthetic>") return;
    session = true;
    const n = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens);
    // A reply split over several lines repeats the same message id and usage: keep the last.
    byMsg.set(String(o.message.id ?? o.requestId ?? `anon-${anon++}`), { day, model, n });
  });
  const days: DayModel = {};
  for (const { day, model, n } of byMsg.values()) add(days, day, model, n);
  return { days, session };
}

/** One Codex session log. */
export async function readCodexFile(file: string): Promise<{ days: DayModel; session: boolean }> {
  const days: DayModel = {};
  let model = "gpt";
  let prevTotal = 0;
  let session = false;
  await readLines(file, (o) => {
    const p = o?.payload ?? o;
    if (p?.model && (o.type === "turn_context" || p.type === "turn_context" || o.type === "session_meta")) model = String(p.model);
    if (p?.type !== "token_count" || !p.info) return;
    const day = dayOf(o.timestamp ?? p.timestamp);
    if (!day) return;
    session = true;
    const last = p.info.last_token_usage;
    const total = p.info.total_token_usage;
    let n = 0;
    // input_tokens includes cached input on Codex; count only the uncached part, like Claude.
    if (last) n = num(last.input_tokens) - num(last.cached_input_tokens) + num(last.output_tokens);
    else if (total) {
      const t = num(total.input_tokens) - num(total.cached_input_tokens) + num(total.output_tokens);
      n = Math.max(0, t - prevTotal);
      prevTotal = t;
    }
    add(days, day, model, Math.max(0, n));
  });
  return { days, session };
}

/**
 * Daily token totals from both apps' transcripts. Files are re-read only when
 * they change (cache in <root>/.harness/token-stats.json).
 */
export async function tokenStats(root: string): Promise<TokenStats> {
  const cacheFile = join(root, ".harness", "token-stats.json");
  let cache: Record<string, FileEntry> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    /* first run */
  }
  const next: Record<string, FileEntry> = {};
  const sources: [Kind, string][] = [
    ["claude", claudeRoot()],
    ["gpt", codexRoot()],
  ];
  for (const [kind, dir] of sources) {
    for (const file of jsonlFiles(dir)) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const hit = cache[file];
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        next[file] = hit;
        continue;
      }
      const r = await (kind === "claude" ? readClaudeFile(file) : readCodexFile(file)).catch(() => ({ days: {}, session: false }));
      // Subagent transcripts add tokens but aren't separate sessions.
      next[file] = { mtimeMs: st.mtimeMs, size: st.size, kind, ...r, session: r.session && !file.includes(`${sep}subagents${sep}`) };
    }
  }
  try {
    mkdirSync(join(root, ".harness"), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(next));
  } catch {
    /* cache is optional */
  }
  const out: TokenStats = { days: {}, sessions: { claude: 0, gpt: 0 }, generatedAt: Date.now(), sources: { claude: claudeRoot(), gpt: codexRoot() } };
  for (const e of Object.values(next)) {
    if (e.session) out.sessions[e.kind]++;
    for (const [day, models] of Object.entries(e.days)) {
      const k = ((out.days[day] ??= {})[e.kind] ??= {});
      for (const [m, n] of Object.entries(models)) k[m] = (k[m] ?? 0) + n;
    }
  }
  return out;
}
