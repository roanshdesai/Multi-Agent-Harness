import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, powerSaveBlocker, type WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadConfig, saveModels, MODEL_ROLES, type HarnessConfig } from "../config.js";
import { Harness } from "../session.js";
import { Host } from "../host.js";
import { startBridge } from "../bridge.js";
import { buildAgents, agentRunsOn, customAgentNames } from "../agents.js";
import { runEvals } from "../eval.js";
import { loadDesignLinks, searchDesignLinks, filterByPlatform } from "../tools/design-library.js";
import { codexStatus, codexLogin } from "../subscription.js";
import { upsertSubagents, removeSubagent, type CustomSubagent } from "../subagents.js";
import { addServer, removeServer, setDisabled } from "../connections.js";
import { claudeBin, openCommandInTerminal } from "../terminal.js";
import { tokenStats } from "../token-stats.js";
import { RemoteControl } from "../remote.js";
import { runComputerUse, COMPUTER_TEST_PROMPT } from "../tools/computer.js";
import { parseCaffeinate, type CaffeinateStatus } from "../caffeinate.js";
import { claudeMemUrls, startClaudeMem, claudeMemDoctor, startHindsight } from "../memory.js";
import { learn, loadInstincts, saveInstinct, effective, type Instinct } from "../instincts.js";
import { loadProjects, saveProjects, flattenProjects, projectFor, bankFor, defaultBank, bankPageUrl, folderExists, type Project, type ProjectsFile } from "../projects.js";
import { listDocs, readDoc, summarizeDoc, cachedSummary } from "../docs.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", ".."); // repo root (dev) or app.asar (packaged)

/**
 * Where config, design library, plugins and chat state live.
 * Dev: the repo. Packaged: ~/.agent-harness, seeded from the bundled defaults on first run.
 */
function resolveRoot(): string {
  if (process.env.HARNESS_ROOT) return process.env.HARNESS_ROOT;
  if (!app.isPackaged) return appRoot;
  const root = join(homedir(), ".agent-harness");
  if (!existsSync(join(root, "harness.config.yaml"))) {
    mkdirSync(root, { recursive: true });
    const seed = join(process.resourcesPath, "seed");
    for (const f of ["harness.config.yaml", ".env.example", "design-library", "evals"]) {
      if (existsSync(join(seed, f))) cpSync(join(seed, f), join(root, f), { recursive: true });
    }
  }
  return root;
}

/** In the packaged app, run the Claude engine and Codex from app.asar.unpacked. */
function locateBundledBinaries() {
  if (!app.isPackaged) return;
  const unpacked = join(process.resourcesPath, "app.asar.unpacked", "node_modules");
  const plat = `${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const pkg of [`claude-agent-sdk-${plat}`, `claude-agent-sdk-${plat}-musl`]) {
    const bin = join(unpacked, "@anthropic-ai", pkg, `claude${exe}`);
    if (existsSync(bin)) {
      process.env.HARNESS_CLAUDE_BIN ??= bin;
      break;
    }
  }
  const vendor = join(unpacked, "@openai", `codex-${plat}`, "vendor");
  if (existsSync(vendor)) {
    for (const triple of readdirSync(vendor)) {
      const bin = join(vendor, triple, "bin", `codex${exe}`);
      if (existsSync(bin)) process.env.HARNESS_CODEX_BIN ??= bin;
    }
  }
}
locateBundledBinaries();

const root = resolveRoot();
// Packaged: settings an older ~/.agent-harness/harness.config.yaml lacks come from the bundled one.
// Also when run from source against another data folder (HARNESS_ROOT): the repo's config fills the gaps.
const cfg: HarnessConfig = loadConfig(root, app.isPackaged ? join(process.resourcesPath, "seed", "harness.config.yaml") : join(appRoot, "harness.config.yaml"));
const prefsFile = join(root, ".harness", "desktop.json");
mkdirSync(dirname(prefsFile), { recursive: true });

interface Prefs {
  workspace: string;
}
function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsFile, "utf8"));
  } catch {
    return { workspace: app.isPackaged ? homedir() : root };
  }
}
let prefs = readPrefs();
const savePrefs = () => writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
// Agents work in the chosen folder; chats are stored per folder.
if (existsSync(prefs.workspace)) process.chdir(prefs.workspace);

// ── windows & the shared host ───────────────────────────────────────────────
const windows = new Map<number, BrowserWindow>(); // keyed by webContents id
let lastFocused = 0;

function winFor(windowId: number) {
  return windows.get(windowId) ?? [...windows.values()][0];
}

/** The only approval in the harness: GitHub pushes, asked with a native dialog. */
const askFor = (windowId: number) => async (question: string) => {
  const win = winFor(windowId);
  const detail = question.replace(/^\s*⚠\s*Approve GitHub action\?\s*/m, "").replace(/\[y\/N\]\s*$/, "").trim();
  const opts = { type: "warning" as const, buttons: ["Deny", "Approve"], defaultId: 0, cancelId: 0, message: "Approve this GitHub action?", detail };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return response === 1 ? "y" : "n";
};

const host = new Host(cfg, askFor);
host.listen((msg) => {
  for (const [id, win] of windows) {
    if (win.isDestroyed()) continue;
    if (msg.type === "tabs") win.webContents.send("tabs", msg.tabs.filter((t) => t.windowId === id));
    else {
      const tab = host.list().find((t) => t.id === msg.tabId);
      if (tab?.windowId === id) win.webContents.send("chat-event", { tabId: msg.tabId, event: msg.event });
    }
  }
});

// One subscription + command check per launch, shared by every tab.
let auth: { plan?: string; error?: string } | null = null;
let availableModels: { value: string; displayName: string }[] = [];
async function ensureAuth() {
  if (auth) return auth;
  const h = new Harness(cfg, askFor(0));
  try {
    auth = { plan: await h.checkAuth() };
  } catch (err) {
    auth = { error: (err as Error).message };
  }
  host.plan = auth.plan;
  host.commands = h.commands;
  availableModels = h.availableModels;
  if (h.usage && (!host.usage || h.usage.at >= host.usage.at)) host.usage = h.usage;
  return auth;
}

function createWindow(chatId?: string) {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 540,
    title: "Multi-Agent Harness",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b0d" : "#fafaf9",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(appRoot, "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const id = win.webContents.id;
  windows.set(id, win);
  (win as any).__initialChat = chatId;
  win.once("ready-to-show", () => win.show());
  win.on("focus", () => (lastFocused = id));
  win.on("closed", () => {
    windows.delete(id);
    host.closeWindow(id);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  void win.loadFile(join(appRoot, "desktop", "renderer", "index.html"));
  lastFocused = id;
  return win;
}

const wid = (sender: WebContents) => sender.id;

// ── memory viewers (claude-mem, Hindsight) ──────────────────────────────────
async function firstUp(urls: string[]): Promise<{ url: string; up: boolean }> {
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      // Any answer means it's running. Don't follow redirects: Hindsight's UI sends / to a
      // dashboard that renders slowly while it's busy, which made it look stopped.
      await fetch(url, { signal: ctrl.signal, redirect: "manual" });
      clearTimeout(t);
      return { url, up: true };
    } catch {
      /* try next */
    }
  }
  return { url: urls[0] ?? "", up: false };
}

// ── IPC: app-level ──────────────────────────────────────────────────────────
ipcMain.handle("init", async (e) => {
  const a = await ensureAuth();
  const win = windows.get(wid(e.sender));
  const initialChat = (win as any)?.__initialChat as string | undefined;
  (win as any).__initialChat = undefined;
  let tabs = host.list(wid(e.sender));
  if (!tabs.length) {
    host.createTab({ windowId: wid(e.sender), chatId: initialChat ?? process.env.HARNESS_RESUME });
    tabs = host.list(wid(e.sender));
  }
  return {
    auth: a,
    subscriptionOnly: cfg.auth.subscription_only,
    codex: codexStatus(cfg.root),
    models: cfg.models,
    availableModels,
    usageRefreshMinutes: cfg.limits.refresh_minutes ?? 0,
    workspace: process.cwd(),
    home: homedir(),
    tabs,
    mcpSkipped: new Harness(cfg, askFor(0)).mcpSkipped,
    plugins: new Harness(cfg, askFor(0)).plugins.map((p) => p.path.split(/[\\/]/).pop()),
    designCount: loadDesignLinks(cfg.design_library).length,
    commands: host.commands ?? [],
    runsOn: agentRunsOn(cfg),
    platform: process.platform,
  };
});
ipcMain.handle("retry-auth", () => {
  auth = null;
  return true;
});
ipcMain.handle("chats", () => host.chats(150));
ipcMain.handle("design", (_e, q: string) => {
  const links = filterByPlatform(loadDesignLinks(cfg.design_library), "web", q);
  return q ? searchDesignLinks(links, q, 40) : links;
});
ipcMain.handle("agents", () => {
  const custom = new Set(customAgentNames(cfg));
  const runsOn = agentRunsOn(cfg);
  return Object.entries(buildAgents(cfg)).map(([name, a]) => ({
    name,
    model: a.model,
    runsOn: runsOn[name] ?? null,
    description: a.description,
    custom: custom.has(name),
  }));
});
ipcMain.handle("memory-status", async () => {
  const hindsight = await firstUp(cfg.memory.hindsight);
  // The current project's own bank, so the Hindsight tab opens on it.
  const bank = bankFor(cfg, process.cwd());
  return {
    claudeMem: await firstUp(claudeMemUrls(cfg)),
    hindsight: { ...hindsight, bank, bankUrl: hindsight.up && hindsight.url ? bankPageUrl(hindsight.url, bank) : undefined },
  };
});
// Start a memory service from the app, then wait (up to a minute) for its viewer to answer.
ipcMain.handle("memory-start", async (_e, key: "claudeMem" | "hindsight") => {
  const r = key === "hindsight" ? await startHindsight(cfg) : await startClaudeMem(cfg);
  if (!r.ok) return { ...r, up: false };
  const urls = key === "hindsight" ? cfg.memory.hindsight : claudeMemUrls(cfg);
  for (let i = 0; i < 30; i++) {
    const st = await firstUp(urls);
    if (st.up) return { ...r, up: true, url: st.url };
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { ...r, up: false, detail: `${r.detail} It hasn't answered on ${urls.join(" or ")} yet.` };
});
ipcMain.handle("memory-doctor", () => claudeMemDoctor(cfg));
/** Make `dir` the folder agents work in; idle tabs move there (with that folder's memory bank). */
function useWorkspace(dir: string) {
  prefs = { ...prefs, workspace: dir };
  savePrefs();
  process.chdir(dir);
  host.setWorkspace(dir);
  return dir;
}
ipcMain.handle("pick-workspace", async (e) => {
  const win = windows.get(wid(e.sender));
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], defaultPath: process.cwd() });
  if (r.canceled || !r.filePaths[0]) return null;
  return useWorkspace(r.filePaths[0]);
});

// Projects: groups of named folders, each with its own Hindsight bank.
function projectsView(data: ProjectsFile = loadProjects(cfg)) {
  const view = (p: Project): Project & { resolvedBank: string; exists: boolean } => ({
    ...p,
    resolvedBank: p.bank ?? defaultBank(p.path),
    exists: folderExists(p.path),
    ...(p.children && { children: p.children.map(view) }),
  });
  return {
    groups: data.groups.map((g) => ({ name: g.name, projects: g.projects.map(view) })),
    current: projectFor(data, process.cwd())?.path ?? null,
    count: flattenProjects(data).length,
  };
}
ipcMain.handle("projects", () => projectsView());
ipcMain.handle("projects-save", (_e, data: ProjectsFile) => projectsView(saveProjects(cfg, data)));
ipcMain.handle("project-open", (_e, dir: string) => {
  if (!folderExists(dir)) throw new Error(`That folder doesn't exist any more: ${dir}`);
  return useWorkspace(dir);
});
// Self-learning: every few minutes, read quiet chats from the owner's projects and update the lessons.
let learning = false;
let lastLearn: { at: number; read: number; lessons: number; promoted: string[]; error?: string } | null = null;
async function runLearning() {
  if (learning || cfg.learning?.enabled === false) return lastLearn;
  learning = true;
  try {
    const h = new Harness(cfg, askFor(0), cfg.root);
    lastLearn = { at: Date.now(), ...(await learn(cfg, (prompt) => h.extractLessons(prompt))) };
  } catch (err) {
    lastLearn = { at: Date.now(), read: 0, lessons: 0, promoted: [], error: (err as Error).message };
  } finally {
    learning = false;
  }
  return lastLearn;
}
void app.whenReady().then(() => {
  if (cfg.learning?.enabled === false) return;
  setTimeout(() => void runLearning(), 2 * 60_000);
  setInterval(() => void runLearning(), Math.max(2, cfg.learning?.every_minutes ?? 10) * 60_000);
});
ipcMain.handle("instincts", () => {
  const bank = bankFor(cfg, process.cwd());
  const { project, global } = loadInstincts(cfg, bank);
  const view = (i: Instinct) => ({ ...i, effective: effective(i) });
  return { bank, project: project.map(view), global: global.map(view), last: lastLearn, running: learning, enabled: cfg.learning?.enabled !== false };
});
ipcMain.handle("instinct-save", (_e, inst: Instinct, remove?: boolean) => {
  saveInstinct(cfg, bankFor(cfg, process.cwd()), inst, !!remove);
  return true;
});
ipcMain.handle("learn-now", () => runLearning());
ipcMain.handle("pick-folder", async (e) => {
  const win = windows.get(wid(e.sender));
  const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], defaultPath: process.cwd() });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle("open-config", () => shell.openPath(join(cfg.root, "harness.config.yaml")));
ipcMain.handle("open-design-library", () => shell.openPath(cfg.design_library));
ipcMain.handle("open-subagents-file", () => shell.openPath(cfg.subagents_file));

// Usage and connections
// Plan usage: re-read on demand when asked to, or when the last read is older than refresh_minutes.
ipcMain.handle("usage", async (_e, force?: boolean) => {
  const every = (cfg.limits.refresh_minutes ?? 0) * 60_000;
  if (force || !host.usageReadAt || (every && Date.now() - host.usageReadAt > every)) await host.refreshUsage();
  return { usage: host.usage, gptUsage: host.gptUsage, limited: host.claudeLimited, gpt: cfg.models.gpt[0], codex: codexStatus(cfg.root) };
});
// Models: choose the model for each role and what the pickers offer; saved to harness.config.yaml.
// Token usage over time from Claude Code and Codex transcripts (home screen stats).
// Connect Codex to ChatGPT (opens the browser), then report the new status.
ipcMain.handle("codex-login", async () => {
  const st = await codexLogin(cfg.root);
  if (st.ok) await host.refreshUsage();
  return st;
});
// /computer test: run computer use directly (no Claude in between) to check it works.
ipcMain.handle("computer-test", () => runComputerUse(cfg, COMPUTER_TEST_PROMPT, { timeoutMinutes: 5 }));

// /caffeinate: keep the computer awake (Electron's power-save blocker).
let caffeine: { id: number; display: boolean; until: number | null; timer?: NodeJS.Timeout } | null = null;
const caffeineStatus = (): CaffeinateStatus => ({ on: !!caffeine, display: !!caffeine?.display, until: caffeine?.until ?? null });
function caffeineOff() {
  if (!caffeine) return;
  clearTimeout(caffeine.timer);
  if (powerSaveBlocker.isStarted(caffeine.id)) powerSaveBlocker.stop(caffeine.id);
  caffeine = null;
  for (const w of windows.values()) w.webContents.send("caffeinate", caffeineStatus());
}
ipcMain.handle("caffeinate", (_e, arg: string) => {
  const req = parseCaffeinate(arg ?? "");
  if (req.action === "status") return caffeineStatus();
  if (req.action === "off" || (req.action === "toggle" && caffeine)) {
    caffeineOff();
    return caffeineStatus();
  }
  caffeineOff();
  const id = powerSaveBlocker.start(req.display ? "prevent-display-sleep" : "prevent-app-suspension");
  caffeine = { id, display: req.display, until: req.durationMs ? Date.now() + req.durationMs : null };
  if (req.durationMs) caffeine.timer = setTimeout(caffeineOff, req.durationMs);
  for (const w of windows.values()) w.webContents.send("caffeinate", caffeineStatus());
  return caffeineStatus();
});
app.on("before-quit", caffeineOff);

// /remote: control the app from another app through MCP.
const remote = new RemoteControl(cfg, host);
void app.whenReady().then(() => remote.restore());
app.on("before-quit", () => remote.stopTunnel());
ipcMain.handle("remote-status", () => remote.status());
ipcMain.handle("remote-start", () => remote.start());
ipcMain.handle("remote-stop", () => remote.stop());
ipcMain.handle("remote-rotate", () => remote.rotate());
ipcMain.handle("remote-tunnel", (_e, on: boolean) => (on ? remote.startTunnel() : remote.stopTunnel()));
ipcMain.handle("handoff", (_e, tabId: string) => host.handoff(tabId));
ipcMain.handle("handoff-continue", (_e, tabId: string, file: string) => host.continueInNewChat(tabId, file));
ipcMain.handle("token-stats", () => tokenStats(cfg.root));
ipcMain.handle("models", () => ({ models: cfg.models, available: availableModels, roles: MODEL_ROLES }));
ipcMain.handle("models-save", (_e, changes: Partial<HarnessConfig["models"]>) => saveModels(cfg, changes));
ipcMain.handle("connections", (_e, reconnect?: string) => host.connections(reconnect));
ipcMain.handle("mcp-toggle", (_e, name: string, enabled: boolean) => setDisabled(cfg, name, !enabled));
ipcMain.handle("mcp-add", (_e, name: string, spec: string) => addServer(cfg, name, spec));
ipcMain.handle("mcp-remove", (_e, name: string) => removeServer(cfg, name));
// Sign in to an MCP server: Claude Code's /mcp screen in a terminal (the SDK has no sign-in call).
ipcMain.handle("mcp-signin", () => {
  const bin = claudeBin();
  if (!bin) throw new Error("Install Claude Code first (npm i -g @anthropic-ai/claude-code).");
  const how = openCommandInTerminal([bin, "/mcp"], process.cwd(), "mcp-sign-in");
  if (!how) throw new Error("Couldn't open a terminal. Run: claude, then type /mcp");
  return how;
});
ipcMain.handle("answer", (_e, tabId: string, id: string, answers: Record<string, string>) => host.answer(tabId, id, answers));
ipcMain.handle("change", (_e, tabId: string, text: string) => host.change(tabId, text, "app"));
ipcMain.handle("context", (_e, tabId: string) => host.context(tabId));

// Documents
const docRoots = () => [process.cwd(), cfg.root];
ipcMain.handle("docs", () => listDocs(process.cwd(), host.touched));
ipcMain.handle("doc-read", (_e, path: string) => {
  const d = readDoc(path, docRoots());
  return { ...d, summary: cachedSummary(cfg, d.path) };
});
ipcMain.handle("doc-summarize", (_e, path: string, force?: boolean) => summarizeDoc(new Harness(cfg, askFor(0)), path, docRoots(), force));
ipcMain.handle("doc-open-external", (_e, path: string) => shell.openPath(readDoc(path, docRoots()).path));

// /subagents
ipcMain.handle("subagents-design", (e, request: string) => host.harnessFor(String(host.list(wid(e.sender))[0]?.id)).designSubagents(request));
ipcMain.handle("subagents-save", (_e, list: CustomSubagent[]) => upsertSubagents(cfg, list).map((a) => a.name));
ipcMain.handle("subagents-remove", (_e, name: string) => removeSubagent(cfg, name));

// ── IPC: per tab ────────────────────────────────────────────────────────────
ipcMain.handle("tab-new", (e, opts: { model?: string; chatId?: string; title?: string; cwd?: string } = {}) =>
  host.createTab({ windowId: wid(e.sender), ...opts }),
);
ipcMain.handle("tab-close", (_e, tabId: string) => host.closeTab(tabId));
ipcMain.handle("tab-focus", (_e, tabId: string) => host.focus(tabId));
ipcMain.handle("tab-history", (_e, tabId: string) => host.history(tabId));
ipcMain.handle("send", (_e, tabId: string, text: string, mentions?: string[], files?: string[]) => host.send(tabId, text, "app", mentions, files ?? []));
// Attaching files: pick them, or save a pasted image into the data folder.
ipcMain.handle("pick-files", async (e) => {
  const win = windows.get(wid(e.sender));
  const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], defaultPath: process.cwd() });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("save-upload", (_e, name: string, bytes: ArrayBuffer) => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const dir = join(cfg.root, ".harness", "uploads", `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  mkdirSync(dir, { recursive: true });
  const safe = (String(name || "pasted").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "") || "pasted").slice(0, 80);
  const file = join(dir, `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${safe}`);
  writeFileSync(file, Buffer.from(bytes));
  return file;
});
ipcMain.handle("stop", (_e, tabId: string) => host.stop(tabId));
ipcMain.handle("btw", (_e, tabId: string, q: string) => host.btw(tabId, q));
ipcMain.handle("new-chat", (_e, tabId: string) => host.newChat(tabId));
ipcMain.handle("open-chat", (_e, tabId: string, chatId: string, title?: string, cwd?: string) => host.openChat(tabId, chatId, title, cwd));
ipcMain.handle("rename", (_e, tabId: string, title: string) => host.rename(tabId, title));
ipcMain.handle("set-verify", (_e, tabId: string, on: boolean) => host.setVerify(tabId, on));
ipcMain.handle("set-model", (_e, tabId: string, model: string) => host.setModel(tabId, model));
ipcMain.handle("fork", async (_e, tabId: string, title?: string) => {
  const id = await host.fork(tabId, title || undefined);
  createWindow(id); // each fork gets its own window
  return id;
});
ipcMain.handle("eval", async (_e, tabId: string, filter: string) => {
  const win = windows.get(host.get(tabId).windowId);
  const note = (text: string) => win && !win.isDestroyed() && win.webContents.send("chat-event", { tabId, event: { type: "note", text } });
  note(`Running evals${filter ? ` matching "${filter}"` : ""}…`);
  await runEvals(host.harnessFor(tabId), filter, note);
});

// ── lifecycle ───────────────────────────────────────────────────────────────
app.setName("Multi-Agent Harness");
// One app instance owns the terminal link; a second launch just focuses the first.
if (!app.requestSingleInstanceLock()) app.quit();
// Opening the app again while it runs: show its window, or open one if it was
// closed (on macOS the app keeps running without windows).
app.on("second-instance", () => {
  const w = [...windows.values()][0];
  if (w) (w.isMinimized() && w.restore(), w.show(), w.focus());
  else if (app.isReady()) createWindow();
});
app.whenReady().then(() => {
  // Let the claude-mem and Hindsight viewers (localhost only) load inside the app.
  session.defaultSession.webRequest.onHeadersReceived({ urls: ["http://localhost/*", "http://127.0.0.1/*"] }, (details, cb) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "x-frame-options") delete headers[k];
      if (k.toLowerCase() === "content-security-policy") headers[k] = headers[k]!.map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ""));
    }
    cb({ responseHeaders: headers });
  });

  createWindow();
  // Terminals started while the app is open attach to it.
  startBridge(
    host,
    (tabId) => {
      const win = winFor(host.get(tabId).windowId);
      win?.webContents.send("focus-tab", tabId);
    },
    () => lastFocused || [...windows.keys()][0] || 0,
  );
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
app.on("before-quit", () => {
  for (const t of host.list()) if (t.busy) void host.stop(t.id);
});
