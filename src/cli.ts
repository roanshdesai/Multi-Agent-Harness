#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Harness } from "./session.js";
import { ChatEngine, expandShortcut, type ChatEvent, type Engine } from "./engine.js";
import { GptChat, isGptChat, listGptChats } from "./gpt-chat.js";
import { buildAgents, agentRunsOn, customAgentNames } from "./agents.js";
import { canonical } from "./commands.js";
import { loadDesignLinks, searchDesignLinks, filterByPlatform } from "./tools/design-library.js";
import { openInNewTerminal, resumeCommand } from "./terminal.js";
import { runEvals } from "./eval.js";
import { codexStatus } from "./subscription.js";
import { connectBridge, type BridgeClient } from "./bridge.js";
import { upsertSubagents, removeSubagent } from "./subagents.js";
import type { TabInfo } from "./host.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const isGpt = (m: string) => /^gpt-/i.test(m);

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? "") : undefined;
};

const cfg = loadConfig();
mkdirSync(join(cfg.root, ".harness"), { recursive: true });

// ── input plumbing: one readline shared by the prompt and approvals ─────────
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let pendingAsk: ((answer: string) => void) | null = null;
const ask = (question: string) =>
  new Promise<string>((resolve) => {
    if (!process.stdin.isTTY && argv.includes("-p")) return resolve("n");
    process.stdout.write(c.yellow(question));
    pendingAsk = resolve;
  });

const harness = new Harness(cfg, ask);
if (flag("--model") && !isGpt(flag("--model")!)) harness.modelOverride = flag("--model");
if (argv.includes("--no-verify")) harness.verifyEnabled = false;

let idleWaiter: (() => void) | null = null;
let busy = false;

// ── rendering (same events whether local or linked to the app) ──────────────
function render(e: ChatEvent) {
  switch (e.type) {
    case "user":
      if (e.source && e.source !== "terminal") console.log(`${c.dim("app ›")} ${e.text}`);
      if (e.queued) console.log(c.dim("(queued; runs after the current turn. Use /btw for a side question)"));
      break;
    case "text":
      console.log(`${e.text}\n`);
      break;
    case "agent":
      console.log(c.cyan(`⇢ ${e.agent}: ${e.description.slice(0, 80)}`));
      break;
    case "tool":
      console.log(c.dim(`${e.sub ? "   ↳ " : "⏺ "}${e.name}(${e.summary.slice(0, 100)})`));
      break;
    case "verify":
      if (e.status === "running") console.log(c.dim(`… verifier (${cfg.models.verifier}) checking, round ${e.round}`));
      else if (e.status === "pass") console.log(c.green("✔ verifier: PASS\n"));
      else console.log(c.red("✘ verifier: FAIL\n") + c.dim((e.feedback ?? "").slice(0, 1500)) + "\n");
      break;
    case "turn-end":
      if (e.isError) console.log(c.red(`(turn ended with an error: ${e.error})`));
      console.log(
        c.dim(
          `[${e.numTurns} turns${cfg.auth.subscription_only || !e.costUsd ? "" : ` · ~$${e.costUsd.toFixed(2)} API`}${e.agents.length ? ` · agents: ${e.agents.join(", ")}` : ""}]`,
        ),
      );
      break;
    case "error":
      console.log(c.red(`Error: ${e.message}`));
      break;
    case "note":
      console.log(c.dim(e.text));
      break;
    case "busy":
      busy = e.busy;
      if (!e.busy) {
        if (idleWaiter) idleWaiter();
        else showPrompt();
      }
      break;
  }
}

// ── local engine (used when the app isn't running) ──────────────────────────
let engine: Engine = new ChatEngine(harness, render);
function useModel(model: string) {
  const want = isGpt(model);
  if (want !== (engine.kind === "gpt")) {
    if (engine.sessionId) console.log(c.dim(`${model} can't continue this conversation, so it starts a new chat.`));
    engine = want ? new GptChat(cfg, model, render) : new ChatEngine(harness, render);
  }
  engine.model = model;
}
if (flag("--model")) useModel(flag("--model")!);
const resumeFlag = flag("--resume");
if (resumeFlag) {
  if (isGptChat(cfg, resumeFlag)) engine = new GptChat(cfg, cfg.models.gpt[0], render);
  engine.resume(resumeFlag);
}
if (argv.includes("--continue") && engine instanceof ChatEngine) {
  const last = engine.lastSession();
  if (last) engine.resume(last);
}

// ── linked mode: same tabs as the desktop app ───────────────────────────────
let bridge: BridgeClient | null = null;
let tabId: string | null = null;
let appTabs: TabInfo[] = [];

function tabLine(t: TabInfo, i: number) {
  const mark = t.id === tabId ? c.green("●") : " ";
  return `${String(i + 1).padStart(2)}. ${mark} ${t.title}  ${c.dim(`${t.model}${t.busy ? " · working" : ""}`)}`;
}

async function attach(b: BridgeClient) {
  bridge = b;
  const hello = await b.request<{ tabs: TabInfo[]; active: string | null; cwd: string }>("hello");
  appTabs = hello.tabs;
  tabId = hello.active ?? appTabs[0]?.id ?? null;
  if (!tabId) tabId = (await b.request<TabInfo>("new-tab")).id;
  b.onPush((msg) => {
    if (msg.type === "tabs") {
      const prev = new Map(appTabs.map((t) => [t.id, t]));
      appTabs = msg.tabs;
      for (const t of appTabs) {
        const was = prev.get(t.id);
        if (t.id !== tabId && was?.busy && !t.busy) console.log(c.dim(`✓ "${t.title}" finished in another tab (/tab ${appTabs.indexOf(t) + 1})`));
      }
      if (tabId && !appTabs.some((t) => t.id === tabId)) {
        console.log(c.yellow("This tab was closed in the app."));
        tabId = appTabs[0]?.id ?? null;
      }
    } else if (msg.type === "event" && msg.tabId === tabId) render(msg.event);
  });
  b.onClose = () => {
    if (!bridge) return;
    console.log(c.yellow("\nThe app closed. Continuing on your own in this terminal."));
    bridge = null;
    showPrompt();
  };
  const tab = appTabs.find((t) => t.id === tabId);
  console.log(c.green("Linked to the Agent Harness app") + c.dim(` · tab "${tab?.title ?? "New chat"}" · ${hello.cwd}`));
  console.log(c.dim("Messages here show in the app and vice versa. /tabs lists tabs, /tab <n> switches, /detach works on your own."));
  const history = await b.request<{ role: string; text: string }[]>("history", { tabId });
  for (const h of history.slice(-6)) console.log(h.role === "user" ? `${c.dim("›")} ${h.text}` : h.role === "assistant" ? `${h.text}\n` : c.dim(`  ${h.text}`));
}

// ── commands ────────────────────────────────────────────────────────────────
function printHelp() {
  let group = "";
  for (const cmd of harness.commands) {
    if (cmd.group !== group) {
      group = cmd.group;
      console.log(`\n${c.bold(group)}`);
    }
    const left = `${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
    const desc = cmd.description.length > 90 ? `${cmd.description.slice(0, 89)}…` : cmd.description;
    console.log(`  ${left.padEnd(30)} ${c.dim(desc)}`);
  }
  console.log(`\n${c.bold("Linked to the app")}\n  ${"/tabs".padEnd(30)} ${c.dim("List the app's tabs")}\n  ${"/tab <n>".padEnd(30)} ${c.dim("Switch to a tab")}\n  ${"/detach".padEnd(30)} ${c.dim("Work on your own in this terminal")}`);
  console.log(c.dim("\nAny other /command is passed to the agent."));
}

async function subagentsCommand(arg: string) {
  const [sub, ...rest] = arg.split(/\s+/);
  if (!arg || sub === "list") {
    const mine = new Set(customAgentNames(cfg));
    for (const [name, a] of Object.entries(buildAgents(cfg)))
      console.log(`${c.cyan(name.padEnd(16))} ${mine.has(name) ? c.yellow("yours ") : "      "}${c.dim(a.model ?? "")}  ${a.description.slice(0, 90)}`);
    console.log(c.dim("\n/subagents <describe what you want>   or   /subagents suggest   ·   /subagents remove <name>"));
    return;
  }
  if (sub === "remove") {
    console.log(removeSubagent(cfg, rest.join(" ")) ? c.green("Removed.") : c.red("No subagent with that name (built-ins can't be removed)."));
    return;
  }
  const request = sub === "suggest" ? "" : arg;
  console.log(c.dim(request ? "The advisor is designing your subagents…" : "The advisor is looking at this project to suggest subagents…"));
  const { summary, subagents } = await harness.designSubagents(request);
  if (summary) console.log(`\n${summary}\n`);
  for (const a of subagents) console.log(`${c.cyan(a.name)} ${c.dim(`(${a.model})`)}\n  ${a.description}\n`);
  const ans = (await ask(`Add ${subagents.length === 1 ? "it" : `these ${subagents.length}`} to the team? [y/N] `)).trim().toLowerCase();
  if (ans === "y" || ans === "yes") {
    upsertSubagents(cfg, subagents);
    console.log(c.green(`Saved to ${cfg.subagents_file}.`));
  } else console.log(c.dim("Not saved."));
}

async function command(line: string): Promise<boolean> {
  const [rawCmd, ...rest] = line.trim().split(/\s+/);
  const cmd = canonical(rawCmd);
  const arg = rest.join(" ");

  // Commands that act on the app's tab when linked
  if (bridge && tabId) {
    switch (cmd) {
      case "/tabs":
        appTabs.forEach((t, i) => console.log(tabLine(t, i)));
        return true;
      case "/tab": {
        const t = appTabs[Number(arg) - 1];
        if (!t) console.log(c.red("No such tab. /tabs lists them."));
        else {
          tabId = t.id;
          console.log(c.green(`Now on "${t.title}"`));
        }
        return true;
      }
      case "/detach": {
        const b = bridge;
        bridge = null;
        b.close();
        console.log(c.dim("Detached. This terminal now works on its own."));
        return true;
      }
      case "/new": {
        const t = await bridge.request<TabInfo>("new-tab", arg ? { model: arg } : {});
        tabId = t.id;
        console.log(c.green("Opened a new tab in the app."));
        return true;
      }
      case "/stop":
        await bridge.request("stop", { tabId });
        return true;
      case "/btw":
        if (arg) printBtw(await bridge.request<string>("btw", { tabId, q: arg }));
        return true;
      case "/fork":
        console.log(c.green(`Forked → ${await bridge.request<string>("fork", { tabId, title: arg || undefined })} (opened in a new app window)`));
        return true;
      case "/model": {
        if (!arg) {
          console.log(`This tab: ${appTabs.find((t) => t.id === tabId)?.model}`);
          return true;
        }
        const r = await bridge.request<{ tabId: string; newTab: boolean }>("set-model", { tabId, model: arg });
        tabId = r.tabId;
        console.log(r.newTab ? c.dim(`Opened a new ${arg} tab (it can't continue the old conversation).`) : `Model: ${arg}`);
        return true;
      }
      case "/resume": {
        const chats = await bridge.request<{ id: string }[]>("chats");
        const id = /^\d+$/.test(arg) ? chats[Number(arg) - 1]?.id : arg;
        if (!id) {
          console.log(c.red("No such chat."));
          return true;
        }
        const r = await bridge.request<{ tab: TabInfo }>("open-chat", { chatId: id });
        tabId = r.tab.id;
        console.log(c.green(`Opened in a new tab: ${r.tab.title}`));
        return true;
      }
    }
  }

  const shortcut = expandShortcut(cmd, arg);
  if (shortcut) {
    send(shortcut);
    return true;
  }

  switch (cmd) {
    case "/help":
      printHelp();
      return true;
    case "/exit":
      process.exit(0);
    case "/new":
      engine.newChat();
      console.log(c.dim("Started a new chat."));
      return true;
    case "/tabs":
    case "/tab":
    case "/detach":
      console.log(c.dim("Not linked to the app. Open Agent Harness and start this terminal again to share its tabs."));
      return true;
    case "/btw":
      if (!arg) console.log("Usage: /btw <question>");
      else void engine.btw(arg).then(printBtw);
      return true;
    case "/stop":
      if (busy) await engine.stop();
      else console.log(c.dim("Nothing running."));
      return true;
    case "/fork": {
      const here = rest.includes("--here");
      const title = rest.filter((r) => r !== "--here").join(" ") || undefined;
      let forkId: string;
      try {
        forkId = await engine.fork(title);
      } catch (err) {
        console.log(c.dim((err as Error).message));
        return true;
      }
      if (here) {
        engine.resume(forkId);
        console.log(c.green(`Switched to fork ${forkId}`));
        return true;
      }
      const how = openInNewTerminal(forkId, process.cwd());
      if (how) console.log(c.green(`Forked → ${forkId} (opened in a new ${how})`));
      else console.log(c.yellow(`Forked → ${forkId}. Run this in a new terminal:\n  `) + resumeCommand(forkId).join(" "));
      return true;
    }
    case "/chats": {
      const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
      const claude = (await listSessions({ dir: process.cwd(), limit: 20 })).map((s) => ({ id: s.sessionId, title: s.customTitle ?? s.summary, updated: s.lastModified, gpt: false }));
      const gpt = listGptChats(cfg, process.cwd()).map((s) => ({ ...s, gpt: true }));
      [...claude, ...gpt]
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 25)
        .forEach((s, i) =>
          console.log(
            `${String(i + 1).padStart(2)}. ${s.id === engine.sessionId ? c.green("●") : " "} ${s.gpt ? c.green("[GPT] ") : ""}${s.title}`.slice(0, 110) +
              c.dim(`  ${new Date(s.updated).toLocaleString()}  ${s.id}`),
          ),
        );
      return true;
    }
    case "/resume": {
      const id = arg || (engine instanceof ChatEngine ? engine.lastSession() : undefined);
      if (!id) {
        console.log(c.red("Usage: /resume <id>"));
        return true;
      }
      if (isGptChat(cfg, id) !== (engine.kind === "gpt")) engine = isGptChat(cfg, id) ? new GptChat(cfg, cfg.models.gpt[0], render) : new ChatEngine(harness, render);
      engine.resume(id);
      console.log(c.green(`Resumed ${id}`));
      return true;
    }
    case "/rename":
      if (engine.sessionId && arg) {
        await engine.rename(arg);
        console.log(c.dim(`Renamed to "${arg}".`));
      }
      return true;
    case "/model":
      if (arg) useModel(arg);
      console.log(`Model: ${engine.model}  ${c.dim(`(Claude: ${[cfg.models.main, cfg.models.advisor, cfg.models.worker].join(", ")} · GPT: ${cfg.models.gpt.join(", ")})`)}`);
      return true;
    case "/verify":
      harness.verifyEnabled = arg !== "off";
      console.log(`Verifier ${harness.verifyEnabled ? "on" : "off"}.`);
      return true;
    case "/subagents":
      try {
        await subagentsCommand(arg);
      } catch (err) {
        console.log(c.red((err as Error).message));
      }
      return true;
    case "/status":
      console.log(
        [
          `link:      ${bridge ? "linked to the Agent Harness app" : "standalone"}`,
          `chat:      ${engine.sessionId ?? "(new)"}  ${c.dim(engine.model)}`,
          `billing:   ${cfg.auth.subscription_only ? `subscription only · Claude plan: ${harness.plan ?? "?"} · Codex: ${codexStatus(cfg.root).detail}` : "API keys allowed (HARNESS_ALLOW_API=1)"}`,
          `models:    ${Object.entries(cfg.models).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join("  ")}`,
          `verifier:  ${harness.verifyEnabled ? "on" : "off"}`,
          `plugins:   ${harness.plugins.map((p) => p.path.split("/").pop()).join(", ") || "(none; run scripts/setup.sh)"}`,
          `mcp off:   ${harness.mcpSkipped.join("; ") || "(all enabled servers configured)"}`,
          `design:    ${loadDesignLinks(cfg.design_library).length} links in ${cfg.design_library}`,
        ].join("\n"),
      );
      return true;
    case "/agents":
      for (const [name, a] of Object.entries(buildAgents(cfg))) {
        const runsOn = agentRunsOn(cfg)[name];
        console.log(`${c.cyan(name.padEnd(14))} ${c.dim(runsOn ? `${runsOn} · coordinated by ${a.model}` : (a.model ?? ""))}  ${a.description.slice(0, 100)}`);
      }
      return true;
    case "/design": {
      // "/design swift toast" includes Swift-only references; otherwise they're hidden
      const links = filterByPlatform(loadDesignLinks(cfg.design_library), "web", arg);
      const hits = arg ? searchDesignLinks(links, arg, 20) : links;
      console.log(hits.map((h) => `- ${h.title}  ${c.dim(h.url)}${h.section ? c.dim(`  [${h.section}]`) : ""}`).join("\n") || c.dim("No matches."));
      return true;
    }
    case "/eval":
      await runEvals(harness, arg, (l) => console.log(/^PASS/.test(l) ? c.green(l) : /^FAIL/.test(l) ? c.red(l) : l));
      return true;
    default:
      return false; // unknown → pass through to the agent (plugin/skill commands)
  }
}

function printBtw(answer: string) {
  console.log(c.cyan("\n┌─ btw ─────────────────────────────"));
  console.log(answer.split("\n").map((l) => c.cyan("│ ") + l).join("\n"));
  console.log(c.cyan("└───────────────────────────────────\n"));
  if (!busy) showPrompt();
}

function send(text: string) {
  if (bridge && tabId) void bridge.request("send", { tabId, text });
  else engine.send(text, "terminal");
}

async function handle(line: string) {
  const text = line.trim();
  if (!text) return showPrompt();
  if (text.startsWith("/")) {
    try {
      if (await command(text)) {
        if (!busy) showPrompt();
        return;
      }
    } catch (err) {
      console.log(c.red((err as Error).message));
      return showPrompt();
    }
  }
  send(text);
}

function showPrompt() {
  if (!process.stdin.isTTY) return;
  const tab = bridge ? appTabs.findIndex((t) => t.id === tabId) + 1 : 0;
  const prefix = bridge ? c.dim(`[tab ${tab}] `) : "";
  rl.setPrompt(prefix + c.bold(`${engine.sessionId || bridge ? "›" : "+"} `));
  rl.prompt();
}

// ── entry ───────────────────────────────────────────────────────────────────
async function main() {
  if (argv[0] === "eval") {
    await runEvals(harness, argv.slice(1).join(" "));
    process.exit(0);
  }
  const once = flag("-p") ?? flag("--print");
  if (once !== undefined) {
    rl.on("line", (l) => pendingAsk && (pendingAsk(l), (pendingAsk = null)));
    await new Promise<void>((resolve) => {
      idleWaiter = resolve;
      engine.send(once, "terminal");
    });
    process.exit(0);
  }

  console.log(
    c.bold("Agent harness") +
      c.dim(`  main ${harness.mainModel} · advisor/coder ${cfg.models.advisor} · workers ${cfg.models.worker} · GPT ${cfg.models.gpt.join("/")}`),
  );

  // Linked to the app? Then the app owns auth, tabs and approvals.
  const b = argv.includes("--standalone") ? null : await connectBridge();
  if (b) {
    try {
      await attach(b);
      void harness.checkAuth().catch(() => undefined); // only to fill /help with skill commands
    } catch (err) {
      console.log(c.red(`Couldn't link to the app: ${(err as Error).message}`));
      bridge = null;
    }
  }
  if (!bridge) {
    try {
      const plan = await harness.checkAuth();
      if (plan) {
        const codex = codexStatus(cfg.root);
        console.log(c.dim(`Claude plan: ${plan} · GPT: ${codex.ok ? codex.detail : c.yellow(codex.detail)}`));
      } else console.log(c.yellow("API billing allowed (HARNESS_ALLOW_API=1)."));
    } catch (err) {
      console.log(c.red((err as Error).message));
      process.exit(1);
    }
    if (engine.sessionId) console.log(c.dim(`Resumed chat ${engine.sessionId}`));
    if (harness.mcpSkipped.length) console.log(c.dim(`MCP not configured: ${harness.mcpSkipped.join("; ")}`));
  }
  console.log(c.dim("Type /help for commands.\n"));

  rl.on("line", (line) => {
    if (pendingAsk) {
      const r = pendingAsk;
      pendingAsk = null;
      return r(line);
    }
    void handle(line);
  });
  rl.on("close", () => process.exit(0));
  showPrompt();
}

void main();
