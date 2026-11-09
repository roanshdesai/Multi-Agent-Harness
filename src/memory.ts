import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessConfig } from "./config.js";

/** Result of trying to start a memory service. */
export interface StartResult {
  ok: boolean;
  /** What happened, in plain words. */
  detail: string;
  /** The command's own output, for when it fails. */
  output?: string;
}

const has = (bin: string) => spawnSync(process.platform === "win32" ? "where" : "which", [bin]).status === 0;

/** Run a command, collect its output, stop it after `timeoutMs`. */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    } catch (err) {
      return resolve({ code: -1, output: (err as Error).message });
    }
    const add = (d: Buffer) => (output = (output + d.toString()).slice(-6000));
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => (output += `\n${err.message}`));
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, output: output.trim() });
    });
  });
}

/**
 * claude-mem's viewer addresses: the port from its own settings
 * (~/.claude-mem/settings.json) first, then the ones in harness.config.yaml.
 */
export function claudeMemUrls(cfg: HarnessConfig): string[] {
  const out: string[] = [];
  const file = join(process.env.CLAUDE_MEM_DATA_DIR ?? join(homedir(), ".claude-mem"), "settings.json");
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(s)) {
        const port = Number(v);
        if (/port/i.test(k) && /worker|viewer|http/i.test(k) && Number.isInteger(port) && port > 0) out.push(`http://localhost:${port}`);
      }
    } catch {
      /* unreadable settings: fall back to the config */
    }
  }
  return [...new Set([...out, ...cfg.memory.claude_mem])];
}

/** Start claude-mem's worker with its own CLI (`npx claude-mem start`). */
export async function startClaudeMem(cfg: HarnessConfig): Promise<StartResult> {
  if (!has("npx")) return { ok: false, detail: "Node.js (npx) isn't on your PATH." };
  const r = await run("npx", ["--yes", "claude-mem", "start"], cfg.root, 120_000);
  if (r.code === 0) return { ok: true, detail: "claude-mem's worker was started.", output: r.output };
  return {
    ok: false,
    detail: /not (installed|found)|install/i.test(r.output)
      ? "claude-mem isn't set up yet. Run `npx claude-mem install` once, then try again."
      : "claude-mem couldn't start. `npx claude-mem doctor` explains what's missing.",
    output: r.output,
  };
}

/** claude-mem's own checkup (`npx claude-mem doctor`). */
export async function claudeMemDoctor(cfg: HarnessConfig): Promise<StartResult> {
  const r = await run("npx", ["--yes", "claude-mem", "doctor"], cfg.root, 120_000);
  return { ok: r.code === 0, detail: r.code === 0 ? "claude-mem doctor finished." : "claude-mem doctor found problems.", output: r.output };
}

/**
 * docker-compose.yml: in the data folder (cfg.root) if you keep one there,
 * otherwise the one shipped with the app's code (one folder above dist/).
 */
export function composeFile(cfg: HarnessConfig): string | null {
  const here = dirname(fileURLToPath(import.meta.url)); // …/dist
  for (const dir of [cfg.root, join(here, ".."), process.cwd()]) {
    const f = join(dir, "docker-compose.yml");
    if (existsSync(f)) return f;
  }
  return null;
}

/**
 * Hindsight's own macOS install (`hindsight-api` + its web UI) runs as launch
 * agents rather than in Docker. Returns the labels whose plist is installed.
 */
export function hindsightLaunchAgents(home = homedir()): string[] {
  const dir = join(home, "Library", "LaunchAgents");
  return ["io.vectorize.hindsight-api", "io.vectorize.hindsight-ui"].filter((l) => existsSync(join(dir, `${l}.plist`)));
}

/**
 * Start Hindsight: through its own launch agents when it's installed natively
 * on a Mac, otherwise with Docker from docker-compose.yml.
 */
export async function startHindsight(cfg: HarnessConfig): Promise<StartResult> {
  const agents = process.platform === "darwin" ? hindsightLaunchAgents() : [];
  if (agents.length && typeof process.getuid === "function") {
    const uid = process.getuid();
    let output = "";
    for (const label of agents) {
      // Loaded already: kickstart restarts it. Not loaded (unloaded by hand): bootstrap loads and starts it.
      let r = await run("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], cfg.root, 30_000);
      if (r.code !== 0) r = await run("launchctl", ["bootstrap", `gui/${uid}`, join(homedir(), "Library", "LaunchAgents", `${label}.plist`)], cfg.root, 30_000);
      output += `${label}: ${r.code === 0 ? "started" : r.output || `exit ${r.code}`}\n`;
      if (r.code !== 0) return { ok: false, detail: `Couldn't start Hindsight's ${label} service.`, output: output.trim() };
    }
    return { ok: true, detail: "Hindsight is starting (its own macOS services).", output: output.trim() };
  }
  const file = composeFile(cfg);
  if (!file) return { ok: false, detail: "Couldn't find docker-compose.yml (looked in the data folder and the app's folder)." };
  if (!has("docker")) return { ok: false, detail: "Docker isn't installed. Install Docker Desktop, open it, then try again." };
  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], cfg.root, 20_000);
  if (info.code !== 0) return { ok: false, detail: "Docker is installed but not running. Open Docker Desktop, wait for it to start, then try again.", output: info.output };
  // The first start downloads the image, which can take a few minutes.
  const r = await run("docker", ["compose", "-f", file, "up", "-d", "hindsight"], dirname(file), 15 * 60_000);
  if (r.code === 0) return { ok: true, detail: "Hindsight is starting in Docker.", output: r.output };
  return { ok: false, detail: "Docker couldn't start Hindsight.", output: r.output };
}
