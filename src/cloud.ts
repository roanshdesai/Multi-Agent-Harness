import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "./config.js";
import { bankFor } from "./projects.js";
import { strongInstincts } from "./instincts.js";
import { claudeBin, openCommandInTerminal } from "./terminal.js";
import type { Ask } from "./guards.js";

/**
 * /cloud: hand the current task to a Claude cloud session (claude.ai/code) so
 * it keeps running while the laptop is in a bag, and pick it back up later.
 *
 * Out: commit the unfinished work plus .cloud/ (hand-off note, the project's
 * Hindsight memory with secrets scrubbed, strong lessons) to a new
 * cloud/<date>-<slug> branch, push it (asks first), start `claude --cloud`
 * on that branch, then put the Mac back on the original branch.
 *
 * Back: fetch the branch, check it out, read what the cloud wrote in
 * .cloud/progress.md, remove .cloud/ and delete the remote branch (asks
 * first), so the memory file doesn't stay on GitHub.
 */

export interface CloudState {
  branch: string;
  /** Branch the Mac was on before. */
  base: string;
  cwd: string;
  task: string;
  at: number;
  sessionId?: string;
  url?: string;
  /** True when the session was started in a terminal window (its link shows there). */
  inTerminal?: boolean;
  memory: boolean;
}

const run = (cmd: string, args: string[], cwd: string, timeout = 120_000) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, env: process.env }, (e, out, err) =>
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code || 1) : 1) : 0, out: String(out), err: String(err) }),
    );
  });
const git = (cwd: string, ...args: string[]) => run("git", args, cwd);

/** Branch name for a hand-off: cloud/2026-11-10-short-task-slug. */
export function cloudBranchName(task: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `cloud/${day}-${slug || "task"}`;
}

/** Remove anything that looks like a credential before it's committed. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[removed: private key]")
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[removed: secret]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*)(["']?)[^\s"'`]{6,}\2/gi, "$1[removed]")
    .replace(/(https?:\/\/[^\s:@/]+:)[^\s@/]+@/g, "$1[removed]@");
}

/** owner/repo of the folder's GitHub remote, or null. */
export async function githubRepo(cwd: string): Promise<{ owner: string; repo: string } | null> {
  // The configured URL, not `remote get-url` (which applies url.*.insteadOf rewrites).
  const r = await git(cwd, "config", "--get", "remote.origin.url");
  const m = r.out.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return r.code === 0 && m ? { owner: m[1], repo: m[2] } : null;
}

/** Whether anyone can read the repo: GitHub answers an anonymous request only for public repos. */
export async function isPublicRepo(owner: string, repo: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetcher(`https://api.github.com/repos/${owner}/${repo}`, { headers: { accept: "application/vnd.github+json", "user-agent": "multi-agent-harness" } });
    if (r.status !== 200) return false;
    return (await r.json() as { private?: boolean }).private === false;
  } catch {
    return false; // can't tell: treated as private, but the push still asks first
  }
}

/**
 * The project's memory for the cloud agent: Hindsight's knowledge pages plus
 * memories recalled for this task, and the strong lessons about how the owner
 * works. Secrets scrubbed; capped so it stays readable.
 */
export async function exportMemory(cfg: HarnessConfig, cwd: string, task: string, fetcher: typeof fetch = fetch): Promise<string> {
  const bank = bankFor(cfg, cwd);
  const api = (cfg.memory.hindsight_mcp ?? "http://localhost:8888/mcp/").replace(/\/mcp\/?.*$/, "");
  const url = (p: string) => `${api}/v1/default/banks/${encodeURIComponent(bank)}${p}`;
  const parts: string[] = [`# Project memory (from Hindsight, bank \`${bank}\`)`, "", "Exported by the harness for this cloud session. Read it before you start. It's a snapshot; the code is the truth when they disagree.", ""];
  try {
    const r = await fetcher(url("/knowledge-base/export"));
    if (r.ok) {
      const files = ((await r.json()) as { files?: { path: string; content: string }[] }).files ?? [];
      for (const f of files.filter((f) => f.path !== "index.md")) parts.push(f.content.replace(/^---[\s\S]*?---\s*/, "").trim(), "");
    }
  } catch {
    parts.push("_(Knowledge pages weren't reachable when this was exported.)_", "");
  }
  try {
    const r = await fetcher(url("/memories/recall"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: task, max_tokens: 3000 }) });
    if (r.ok) {
      const j = (await r.json()) as { results?: { text?: string }[] };
      const lines = (j.results ?? []).map((x) => x.text).filter(Boolean);
      if (lines.length) parts.push("## Memories about this task", "", ...lines.map((t) => `- ${t}`), "");
    }
  } catch {
    /* recall is optional */
  }
  const lessons = strongInstincts(cfg, cwd);
  if (lessons.length) parts.push("## How the user wants work done (learned)", "", ...lessons.map((i) => `- ${i.trigger}: ${i.action}`), "");
  let text = scrubSecrets(parts.join("\n"));
  if (text.length > 120_000) text = `${text.slice(0, 120_000)}\n\n_(cut here to keep it short)_\n`;
  return text;
}

/** What the cloud agent is told to do. */
export function cloudInstructions(branch: string, task: string, memory: boolean): string {
  return [
    `Continue a task handed over from the user's Mac. You're on branch ${branch}.`,
    `First read .cloud/context.md (what the task is, what's done, what's left)${memory ? " and .cloud/memory.md (the project's memory and how the user wants work done)" : ""}.`,
    `Then carry on with the work. Commit and push to ${branch} as you go; never push to main or master and don't open or merge a pull request.`,
    `Before you stop, write .cloud/progress.md: what you did, what's left, and anything the user must decide. Commit and push it.`,
    ``,
    `Task: ${task}`,
  ].join("\n");
}

/** Paths that must never be committed, even if git would track them. */
const NEVER = /(^|\/)(\.env(\..*)?|.*\.pem|id_rsa[^/]*|.*\.tfvars|mcp-servers\.json)$/;

export interface SendResult extends CloudState {
  note: string;
}

/**
 * Send the tab's work to the cloud. `handoffText` is the /handoff summary.
 * `ask` shows the GitHub approval (pushes always ask). `confirmPublic` asks
 * whether memory may go to a public repo.
 */
export async function sendToCloud(
  cfg: HarnessConfig,
  cwd: string,
  task: string,
  handoffText: string,
  ask: Ask,
  confirmPublic: (repo: string) => Promise<boolean>,
  opts: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<SendResult> {
  if ((await git(cwd, "rev-parse", "--is-inside-work-tree")).code !== 0) throw new Error("This folder isn't a git repository, so it can't go to the cloud.");
  const gh = await githubRepo(cwd);
  if (!gh) throw new Error("This project has no GitHub remote (origin). Cloud sessions clone from GitHub.");
  const base = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).out.trim();
  if (!base || base === "HEAD") throw new Error("You're not on a branch (detached HEAD). Check out a branch first.");
  const branch = cloudBranchName(task, opts.now);
  let memory = true;
  if (await isPublicRepo(gh.owner, gh.repo, opts.fetcher)) memory = await confirmPublic(`${gh.owner}/${gh.repo}`);

  if ((await git(cwd, "switch", "-c", branch)).code !== 0) throw new Error(`Couldn't create the branch ${branch}.`);
  try {
    mkdirSync(join(cwd, ".cloud"), { recursive: true });
    writeFileSync(join(cwd, ".cloud", "context.md"), scrubSecrets(`# Hand-off from the Mac\n\nTask: ${task}\nFrom branch: ${base}\n\n${handoffText}\n`));
    if (memory) writeFileSync(join(cwd, ".cloud", "memory.md"), await exportMemory(cfg, cwd, task, opts.fetcher));
    writeFileSync(join(cwd, ".cloud", "README.md"), "Hand-off files for a Claude cloud session, written by Multi-Agent Harness. They're removed when the work comes back to the Mac; don't merge them.\n");
    await git(cwd, "add", "-A");
    // Belt and braces: unstage anything that must never be committed.
    const staged = (await git(cwd, "diff", "--cached", "--name-only")).out.split("\n").filter(Boolean);
    const bad = staged.filter((f) => NEVER.test(f));
    if (bad.length) await git(cwd, "reset", "-q", "--", ...bad);
    const commit = await git(cwd, "commit", "-q", "-m", `Cloud hand-off: ${task.slice(0, 60)}`, "-m", "Unfinished work and .cloud/ hand-off files, sent to a Claude cloud session by Multi-Agent Harness.");
    if (commit.code !== 0) throw new Error(`Couldn't commit the work: ${(commit.err || commit.out).trim().slice(0, 300)}`);
    const files = (await git(cwd, "show", "--name-only", "--format=", "HEAD")).out.trim().split("\n").filter(Boolean);
    const answer = await ask(
      `⚠ Approve GitHub action?\nPush the branch ${branch} to ${gh.owner}/${gh.repo} for a Claude cloud session.\n${files.length} file(s): ${files.slice(0, 12).join(", ")}${files.length > 12 ? ", …" : ""}${memory ? "\nIncludes .cloud/memory.md (project memory, secrets removed)." : ""} [y/N]`,
    );
    if (!/^y/i.test(answer.trim())) throw new Error("Push not approved, so nothing was sent to the cloud.");
    const push = await git(cwd, "push", "-u", "origin", branch);
    if (push.code !== 0) throw new Error(`Push failed: ${(push.err || push.out).trim().slice(0, 300)}`);
  } catch (err) {
    // Undo locally: back to the original branch with the work as it was (uncommitted).
    const head = (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).out.trim();
    if (head === branch) {
      const made = (await git(cwd, "log", "-1", "--format=%s")).out.startsWith("Cloud hand-off:");
      if (made) await git(cwd, "reset", "-q", "--soft", "HEAD~1");
      await git(cwd, "reset", "-q", "--", ".cloud");
      await run("rm", ["-rf", join(cwd, ".cloud")], cwd);
      await git(cwd, "switch", "-q", base);
      await git(cwd, "branch", "-q", "-D", branch);
    }
    throw err;
  }

  // Start the cloud session on this branch (it clones the current branch from GitHub).
  const state: CloudState = { branch, base, cwd, task, at: Date.now(), memory };
  const instructions = cloudInstructions(branch, task, memory);
  const bin = claudeBin() ?? "claude";
  const r = await run(bin, ["-p", "--output-format", "json", "--cloud", instructions], cwd, 180_000);
  const parsed = parseCloudStart(r.out + "\n" + r.err);
  if (parsed.sessionId || parsed.url) {
    Object.assign(state, parsed);
    await git(cwd, "switch", "-q", base); // the work lives on the branch now; the Mac goes back
    return { ...state, note: `Sent to the cloud on ${branch}.` };
  }
  // Couldn't start it here: open it in a terminal window, where Claude Code shows the link.
  openCommandInTerminal([bin, "--cloud", instructions], cwd, "cloud");
  state.inTerminal = true;
  return { ...state, note: `The branch ${branch} is pushed. The cloud session is starting in a terminal window, which shows its link. Stay on ${branch} until it has started, then switch back to ${base}.` };
}

/** Session id and link from `claude --cloud` output (JSON or text). */
export function parseCloudStart(out: string): { sessionId?: string; url?: string } {
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as { session_id?: string; url?: string };
      if (j.session_id || j.url) return { sessionId: j.session_id, url: j.url };
    } catch {
      /* not JSON */
    }
  }
  const id = out.match(/\b((?:session|cse)_[A-Za-z0-9]+)\b/)?.[1];
  const url = out.match(/https:\/\/claude\.ai\/code\/[^\s"']+/)?.[0];
  return { ...(id && { sessionId: id }), ...(url && { url }) };
}

/**
 * Bring the cloud's work back: fetch and check out the branch, read
 * .cloud/progress.md, remove .cloud/ (commit), and delete the remote branch
 * (asks first). Returns the text to start the next chat from.
 */
export async function returnFromCloud(state: CloudState, ask: Ask): Promise<{ summary: string; note: string }> {
  const cwd = state.cwd;
  const dirty = (await git(cwd, "status", "--porcelain", "--untracked-files=no")).out.trim();
  if (dirty) throw new Error("You have uncommitted changes here. Commit or stash them first, then continue.");
  const f = await git(cwd, "fetch", "origin", state.branch);
  if (f.code !== 0) throw new Error(`Couldn't fetch ${state.branch}: ${(f.err || f.out).trim().slice(0, 300)}`);
  const sw = (await git(cwd, "rev-parse", "--verify", "-q", state.branch)).code === 0
    ? await git(cwd, "switch", "-q", state.branch)
    : await git(cwd, "switch", "-q", "-c", state.branch, "--track", `origin/${state.branch}`);
  if (sw.code !== 0) throw new Error(`Couldn't check out ${state.branch}: ${(sw.err || sw.out).trim().slice(0, 300)}`);
  await git(cwd, "merge", "-q", "--ff-only", `origin/${state.branch}`);
  const read = (name: string) => {
    const p = join(cwd, ".cloud", name);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  };
  const progress = read("progress.md");
  const context = read("context.md");
  const commits = (await git(cwd, "log", "--format=- %s", `${state.base}..HEAD`)).out.trim();
  if (existsSync(join(cwd, ".cloud"))) {
    await git(cwd, "rm", "-r", "-q", "--", ".cloud");
    await git(cwd, "commit", "-q", "-m", "Remove the cloud hand-off files");
  }
  let note = `Back on ${state.branch} with the cloud's work.`;
  const answer = await ask(`⚠ Approve GitHub action?\nDelete the branch ${state.branch} from GitHub, so the hand-off and memory files don't stay there. The work stays on your Mac (branch ${state.branch}). [y/N]`);
  if (/^y/i.test(answer.trim())) {
    const del = await git(cwd, "push", "origin", "--delete", state.branch);
    note += del.code === 0 ? " The GitHub copy of the branch was deleted." : ` Deleting it on GitHub failed: ${(del.err || del.out).trim().slice(0, 200)}`;
    await git(cwd, "branch", "-q", "--unset-upstream");
  } else note += ` The branch is still on GitHub (with .cloud/ in its history).`;
  const summary = [
    `[This chat continues a task that ran in a Claude cloud session${state.url ? ` (${state.url})` : ""}. The work is now on the branch ${state.branch} on this Mac.]`,
    "",
    "## What the cloud session reported",
    progress || "_It didn't write .cloud/progress.md. Look at its commits below and the code._",
    "",
    "## Its commits",
    commits || "_(none)_",
    "",
    "## The original hand-off",
    context,
  ].join("\n");
  return { summary, note };
}

/** Saved cloud hand-offs, keyed by the chat's session id (survives restarts). */
const stateFile = (cfg: HarnessConfig) => join(cfg.root, ".harness", "cloud.json");
export function loadCloudStates(cfg: HarnessConfig): Record<string, CloudState> {
  try {
    return JSON.parse(readFileSync(stateFile(cfg), "utf8"));
  } catch {
    return {};
  }
}
export function saveCloudState(cfg: HarnessConfig, chatId: string, state: CloudState | null) {
  const all = loadCloudStates(cfg);
  if (state) all[chatId] = state;
  else delete all[chatId];
  mkdirSync(join(cfg.root, ".harness"), { recursive: true });
  writeFileSync(stateFile(cfg), JSON.stringify(all, null, 1));
}

