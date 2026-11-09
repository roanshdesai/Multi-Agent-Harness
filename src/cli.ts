#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Harness } from "./session.js";
import { ChatEngine, expandShortcut, type ChatEvent } from "./engine.js";
import { buildAgents, agentRunsOn } from "./agents.js";
import { canonical } from "./commands.js";
import { loadDesignLinks, searchDesignLinks, filterByPlatform } from "./tools/design-library.js";
import { openInNewTerminal, resumeCommand } from "./terminal.js";
import { runEvals } from "./eval.js";
import { codexStatus } from "./subscription.js";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

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
if (flag("--model")) harness.modelOverride = flag("--model");
if (argv.includes("--no-verify")) harness.verifyEnabled = false;

let idleWaiter: (() => void) | null = null;

function render(e: ChatEvent) {
  switch (e.type) {
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
    case "queued":
      console.log(c.dim("(queued; runs after the current turn. Use /btw for a side question)"));
      break;
    case "turn-end":
      if (e.isError) console.log(c.red(`(turn ended with an error: ${e.error})`));
      console.log(
        c.dim(
          `[${e.numTurns} turns${cfg.auth.subscription_only ? "" : ` · ~$${e.costUsd.toFixed(2)} API`}${e.agents.length ? ` · agents: ${e.agents.join(", ")}` : ""}]`,
        ),
      );
      break;
    case "error":
      console.log(c.red(`Error: ${e.message}`));
      break;
    case "busy":
      if (!e.busy) {
        if (idleWaiter) idleWaiter();
        else showPrompt();
      }
      break;
  }
}

const chat = new ChatEngine(harness, render);
const resumeFlag = flag("--resume");
if (resumeFlag) chat.sessionId = resumeFlag;
if (argv.includes("--continue")) chat.sessionId = chat.lastSession();

// ── slash commands ──────────────────────────────────────────────────────────
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
  console.log(c.dim("\nAny other /command is passed to the agent."));
}

async function command(line: string): Promise<boolean> {
  const [rawCmd, ...rest] = line.trim().split(/\s+/);
  const cmd = canonical(rawCmd);
  const arg = rest.join(" ");

  const shortcut = expandShortcut(cmd, arg);
  if (shortcut) {
    chat.send(shortcut);
    return true;
  }

  switch (cmd) {
    case "/help":
      printHelp();
      return true;
    case "/exit":
      process.exit(0);
    case "/new":
      chat.newChat();
      console.log(c.dim("Started a new chat."));
      return true;
    case "/btw":
      if (!arg) console.log("Usage: /btw <question>");
      else
        void chat.btw(arg).then((answer) => {
          console.log(c.cyan("\n┌─ btw ─────────────────────────────"));
          console.log(answer.split("\n").map((l) => c.cyan("│ ") + l).join("\n"));
          console.log(c.cyan("└───────────────────────────────────\n"));
          if (!chat.busy) showPrompt();
        });
      return true;
    case "/stop":
      if (chat.busy) await chat.stop();
      else console.log(c.dim("Nothing running."));
      return true;
    case "/fork": {
      const here = rest.includes("--here");
      const title = rest.filter((r) => r !== "--here").join(" ") || undefined;
      let forkId: string;
      try {
        forkId = await chat.fork(title);
      } catch (err) {
        console.log(c.dim((err as Error).message));
        return true;
      }
      if (here) {
        chat.resume(forkId);
        console.log(c.green(`Switched to fork ${forkId}`));
        return true;
      }
      const how = openInNewTerminal(forkId, process.cwd());
      if (how) console.log(c.green(`Forked → ${forkId} (opened in a new ${how})`));
      else
        console.log(
          c.yellow(`Forked → ${forkId}. No terminal could be opened from here; run this in a new terminal:\n  `) +
            resumeCommand(forkId).join(" "),
        );
      return true;
    }
    case "/chats": {
      const list = await chat.listChats(20);
      list.forEach((s, i) =>
        console.log(
          `${String(i + 1).padStart(2)}. ${s.id === chat.sessionId ? c.green("●") : " "} ${s.title}`.slice(0, 110) +
            c.dim(`  ${new Date(s.updated).toLocaleString()}  ${s.id}`),
        ),
      );
      return true;
    }
    case "/resume": {
      let id: string | undefined;
      if (/^\d+$/.test(arg)) id = (await chat.listChats(50))[Number(arg) - 1]?.id;
      else id = arg || chat.lastSession();
      if (id) {
        chat.resume(id);
        console.log(c.green(`Resumed ${id}`));
      } else console.log(c.red("No such chat."));
      return true;
    }
    case "/rename":
      if (chat.sessionId && arg) {
        await chat.rename(arg);
        console.log(c.dim(`Renamed to "${arg}".`));
      }
      return true;
    case "/model":
      if (arg) harness.modelOverride = arg;
      console.log(`Main model: ${harness.mainModel}`);
      return true;
    case "/verify":
      harness.verifyEnabled = arg !== "off";
      console.log(`Verifier ${harness.verifyEnabled ? "on" : "off"}.`);
      return true;
    case "/status":
      console.log(
        [
          `chat:      ${chat.sessionId ?? "(new)"}`,
          `billing:   ${cfg.auth.subscription_only ? `subscription only · Claude plan: ${harness.plan ?? "?"} · Codex: ${codexStatus(cfg.root).detail}` : "API keys allowed (HARNESS_ALLOW_API=1)"}`,
          `models:    ${Object.entries(cfg.models).map(([k, v]) => `${k}=${v}`).join("  ")}`,
          `main now:  ${harness.mainModel}`,
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
        console.log(`${c.cyan(name.padEnd(12))} ${c.dim(runsOn ? `${runsOn} · coordinated by ${a.model}` : (a.model ?? ""))}  ${a.description}`);
      }
      return true;
    case "/design": {
      // "/design swift toast" includes Swift-only references; otherwise they're hidden
      const links = filterByPlatform(loadDesignLinks(cfg.design_library), "web", arg);
      const hits = arg ? searchDesignLinks(links, arg, 20) : links;
      console.log(
        hits.map((h) => `- ${h.title}  ${c.dim(h.url)}${h.section ? c.dim(`  [${h.section}]`) : ""}`).join("\n") || c.dim("No matches."),
      );
      return true;
    }
    case "/eval":
      await runEvals(harness, arg, (l) => console.log(/^PASS/.test(l) ? c.green(l) : /^FAIL/.test(l) ? c.red(l) : l));
      return true;
    default:
      return false; // unknown → pass through to the agent (plugin/skill commands)
  }
}

async function handle(line: string) {
  const text = line.trim();
  if (!text) return showPrompt();
  if (text.startsWith("/") && (await command(text))) {
    if (!chat.busy) showPrompt();
    return;
  }
  chat.send(text);
}

function showPrompt() {
  if (process.stdin.isTTY) rl.setPrompt(c.bold(`${chat.sessionId ? "›" : "+"} `)), rl.prompt();
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
      chat.send(once);
    });
    process.exit(0);
  }

  console.log(
    c.bold("Agent harness") +
      c.dim(`  main ${harness.mainModel} · advisor/coder ${cfg.models.advisor} · workers ${cfg.models.worker} · gui ${cfg.models.gui}`),
  );
  try {
    const plan = await harness.checkAuth();
    if (plan) {
      const codex = codexStatus(cfg.root);
      console.log(c.dim(`Claude plan: ${plan} · GPT-6 Astra: ${codex.ok ? codex.detail : c.yellow(codex.detail)}`));
    } else console.log(c.yellow("API billing allowed (HARNESS_ALLOW_API=1)."));
  } catch (err) {
    console.log(c.red((err as Error).message));
    process.exit(1);
  }
  if (chat.sessionId) console.log(c.dim(`Resumed chat ${chat.sessionId}`));
  if (harness.mcpSkipped.length) console.log(c.dim(`MCP not configured: ${harness.mcpSkipped.join("; ")}`));
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
