import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, type WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadConfig, type HarnessConfig } from "../config.js";
import { Harness } from "../session.js";
import { ChatEngine, expandShortcut, type ChatEvent } from "../engine.js";
import { buildAgents } from "../agents.js";
import { loadDesignLinks, searchDesignLinks, filterByPlatform } from "../tools/design-library.js";
import { codexStatus } from "../subscription.js";

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
const cfg: HarnessConfig = loadConfig(root);
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

// One subscription check per app launch.
let auth: { plan?: string; error?: string } | null = null;

interface WinState {
  win: BrowserWindow;
  harness: Harness;
  chat: ChatEngine;
}
const windows = new Map<number, WinState>();

function createWindow(sessionId?: string) {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: "Agent Harness",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111113" : "#fbfbfa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 18 },
    show: false,
    webPreferences: {
      preload: join(appRoot, "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The only approval in the harness: GitHub pushes, asked with a native dialog.
  const ask = async (question: string) => {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Deny", "Approve"],
      defaultId: 0,
      cancelId: 0,
      message: "Approve this GitHub action?",
      detail: question.replace(/^\s*⚠\s*Approve GitHub action\?\s*/m, "").replace(/\[y\/N\]\s*$/, "").trim(),
    });
    return response === 1 ? "y" : "n";
  };

  const harness = new Harness(cfg, ask);
  const send = (e: ChatEvent) => !win.isDestroyed() && win.webContents.send("chat-event", e);
  const chat = new ChatEngine(harness, send, { stream: true });
  if (sessionId) chat.sessionId = sessionId;
  windows.set(win.webContents.id, { win, harness, chat });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => windows.delete(win.webContents.id));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  void win.loadFile(join(appRoot, "desktop", "renderer", "index.html"));
  return win;
}

function state(sender: WebContents): WinState {
  const s = windows.get(sender.id);
  if (!s) throw new Error("Unknown window");
  return s;
}

// ── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.handle("init", async (e) => {
  const { harness, chat } = state(e.sender);
  if (!auth) {
    try {
      auth = { plan: await harness.checkAuth() };
    } catch (err) {
      auth = { error: (err as Error).message };
    }
  }
  if (auth.plan) harness.plan = auth.plan;
  const codex = codexStatus(cfg.root);
  return {
    auth,
    subscriptionOnly: cfg.auth.subscription_only,
    codex,
    models: cfg.models,
    mainModel: harness.mainModel,
    verify: harness.verifyEnabled,
    workspace: process.cwd(),
    sessionId: chat.sessionId ?? null,
    history: chat.sessionId ? await chat.history(chat.sessionId) : [],
    mcpSkipped: harness.mcpSkipped,
    plugins: harness.plugins.map((p) => p.path.split(/[\\/]/).pop()),
    designCount: loadDesignLinks(cfg.design_library).length,
    platform: process.platform,
  };
});

ipcMain.handle("retry-auth", () => {
  auth = null;
  return true;
});

ipcMain.handle("send", (e, text: string) => {
  const { chat } = state(e.sender);
  const [cmd, ...rest] = text.trim().split(/\s+/);
  chat.send(expandShortcut(cmd, rest.join(" ")) ?? text);
});

ipcMain.handle("stop", (e) => state(e.sender).chat.stop());
ipcMain.handle("btw", (e, q: string) => state(e.sender).chat.btw(q));

ipcMain.handle("new-chat", (e) => {
  state(e.sender).chat.newChat();
  return true;
});

ipcMain.handle("open-chat", async (e, id: string) => {
  const { chat } = state(e.sender);
  if (chat.busy) throw new Error("Wait for the current turn to finish (or press Stop) before switching chats.");
  chat.resume(id);
  return chat.history(id);
});

ipcMain.handle("chats", (e) => state(e.sender).chat.listChats(100));

ipcMain.handle("fork", async (e, title?: string) => {
  const id = await state(e.sender).chat.fork(title || undefined);
  createWindow(id); // each fork gets its own window
  return id;
});

ipcMain.handle("rename", (e, title: string) => state(e.sender).chat.rename(title));

ipcMain.handle("set-verify", (e, on: boolean) => {
  state(e.sender).harness.verifyEnabled = on;
  return on;
});

ipcMain.handle("set-model", (e, model: string) => {
  const { harness } = state(e.sender);
  harness.modelOverride = model || undefined;
  return harness.mainModel;
});

ipcMain.handle("design", (_e, q: string) => {
  const links = filterByPlatform(loadDesignLinks(cfg.design_library), "web", q);
  return q ? searchDesignLinks(links, q, 40) : links;
});

ipcMain.handle("agents", () =>
  Object.entries(buildAgents(cfg)).map(([name, a]) => ({ name, model: a.model, description: a.description })),
);

ipcMain.handle("pick-workspace", async (e) => {
  const { win } = state(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], defaultPath: process.cwd() });
  if (r.canceled || !r.filePaths[0]) return null;
  prefs = { ...prefs, workspace: r.filePaths[0] };
  savePrefs();
  process.chdir(prefs.workspace);
  for (const s of windows.values()) s.chat.newChat();
  return prefs.workspace;
});

ipcMain.handle("open-config", () => shell.openPath(join(cfg.root, "harness.config.yaml")));
ipcMain.handle("open-design-library", () => shell.openPath(cfg.design_library));

// ── lifecycle ───────────────────────────────────────────────────────────────
app.setName("Agent Harness");
app.whenReady().then(() => {
  createWindow(process.env.HARNESS_RESUME);
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
// Stop any running turns so no agent keeps working after the app quits.
app.on("before-quit", () => {
  for (const s of windows.values()) void s.chat.stop();
});
