#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Harness } from "./session.js";
import { ChatEngine, expandShortcut, mentionNote, parseMentions, type ChatEvent, type Engine } from "./engine.js";
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
import type { AgentQuestion } from "./session.js";
import { describeUsage, isExhausted, formatReset } from "./usage.js";
import { readCodexUsage } from "./codex-usage.js";
import { runComputerUse, COMPUTER_TEST_PROMPT } from "./tools/computer.js";
import { parseCaffeinate, describeCaffeinate, type CaffeinateStatus } from "./caffeinate.js";
import { spawn as spawnChild, spawnSync as spawnSyncChild, type ChildProcess } from "node:child_process";
import { saveCustomServer, removeCustomServer, setDisabled, parseServerSpec } from "./connections.js";
import { listDocs, summarizeDoc } from "./docs.js";
import type { ContextInfo } from "./session.js";

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
// Prompts waiting for a line, oldest first. Only the head is shown; a push
// approval and an agent question arriving together each get their own turn.
interface PendingAsk {
  question: string;
  resolve: (answer: string) => void;
  /** Agent question id, so an answer given in the app cancels only that prompt. */
  tag?: string;
}
const asks: PendingAsk[] = [];
const showHeadAsk = () => asks[0] && process.stdout.write(c.yellow(asks[0].question));
/** Hand a typed line to the oldest waiting prompt. Returns false if none is waiting. */
function answerAsk(line: string): boolean {
  const head = asks.shift();
  if (!head) return false;
  head.resolve(line);
  showHeadAsk();
  return true;
}
/** Drop the prompts for an agent question that was answered elsewhere. */
function cancelAsks(tag: string) {
  const wasHead = asks[0]?.tag === tag;
  for (let i = asks.length - 1; i >= 0; i--) if (asks[i].tag === tag) asks.splice(i, 1);
  if (wasHead) showHeadAsk();
}
const ask = (question: string, tag?: string) =>
  new Promise<string>((resolve) => {
    if (!process.stdin.isTTY && argv.includes("-p")) return resolve("n");
    asks.push({ question, resolve, tag });
    if (asks.length === 1) showHeadAsk();
  });

const harness = new Harness(cfg, ask);
if (flag("--model") && !isGpt(flag("--model")!)) harness.modelOverride = flag("--model");
if (argv.includes("--no-verify")) harness.verifyEnabled = false;

let idleWaiter: (() => void) | null = null;
let handingOff = false;
let busy = false;

// ── rendering (same events whether local or linked to the app) ──────────────
function render(e: ChatEvent) {
  switch (e.type) {
    case "user":
      if (e.change && e.source === "terminal") console.log(c.cyan("↻ correction sent; the agent adjusts at its next step"));
      else if (e.source && e.source !== "terminal") console.log(`${c.dim(e.change ? "app (change) ›" : "app ›")} ${e.text}`);
      if (e.queued) console.log(c.dim("(queued; runs after the current turn. Use /btw for a side question)"));
      break;
    case "text":
      console.log(`${e.text}\n`);
      break;
    case "agent":
      console.log(c.cyan(`⇢ ${e.agent}: ${e.description.slice(0, 80)}`));
      break;
    case "tool":
      if (e.name === "AskUserQuestion") break; // shown as the question itself
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
    case "advisor":
      if (e.status === "asked") console.log(c.cyan(`✦ consulting the advisor (${cfg.models.advisor})…`));
      break;
    case "question":
      void askQuestions(e.id, e.questions);
      break;
    case "question-answered":
      if (openQuestion === e.id) {
        openQuestion = null;
        cancelAsks(e.id); // answered elsewhere: stop waiting for a line here (other prompts stay)
        console.log(c.dim(`(answered${e.answers ? `: ${Object.values(e.answers).join(" · ")}` : ""})`));
        if (!busy && !asks.length) showPrompt();
      }
      break;
    case "usage":
      if (e.usage.windows.some((w) => (w.utilization ?? 0) >= cfg.limits.warn_at) && !warnedUsage) {
        warnedUsage = true;
        console.log(c.yellow(`Heads-up: ${e.usage.windows.map((w) => `${w.label} ${Math.round((w.utilization ?? 0) * 100)}%`).join(", ")}`));
      }
      break;
    case "limit":
      if (!bridge) {
        handingOff = true; // keep -p alive until GPT finishes
        void continueOnGpt(e.prompt, e.resetsAt).finally(() => (handingOff = false));
      }
      break;
    case "busy":
      busy = e.busy;
      if (!e.busy) {
        if (handingOff) break;
        if (idleWaiter) idleWaiter();
        else showPrompt();
      }
      break;
  }
}

// ── /context: the square grid Claude Code shows ────────────────────────────
const CTX_COLOR: Record<string, (s: string) => string> = {
  system_prompt: (s) => `\x1b[90m${s}\x1b[0m`,
  system_tools: (s) => `\x1b[34m${s}\x1b[0m`,
  mcp_tools: (s) => `\x1b[35m${s}\x1b[0m`,
  mcp_instructions: (s) => `\x1b[35m${s}\x1b[0m`,
  custom_agents: (s) => `\x1b[95m${s}\x1b[0m`,
  memory_files: (s) => `\x1b[32m${s}\x1b[0m`,
  skills: (s) => `\x1b[33m${s}\x1b[0m`,
  messages: (s) => `\x1b[31m${s}\x1b[0m`,
};
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
function printContext(ctx: ContextInfo | null) {
  if (!ctx) return console.log(c.dim("No context yet. Send a message first."));
  const lines = ctx.grid.map((row) => row.map((sq) => (sq.fill ? (CTX_COLOR[sq.id] ?? c.dim)(sq.fill >= 0.7 ? "⛁" : "⛀") : c.dim("⛶"))).join(" "));
  const legend = [
    `${c.bold(`${ctx.percentage}%`)}  ${fmtK(ctx.total)}/${fmtK(ctx.max)} tokens · ${ctx.model}`,
    "",
    ...ctx.categories
      .filter((x) => x.kind !== "deferred")
      .map((x) => `${(CTX_COLOR[x.id] ?? c.dim)(x.kind === "free" ? "⛶" : "⛁")} ${x.name}: ${fmtK(x.tokens)} (${((x.tokens / ctx.max) * 100).toFixed(1)}%)`),
  ];
  for (let i = 0; i < Math.max(lines.length, legend.length); i++) console.log(`  ${lines[i] ?? " ".repeat(19)}   ${legend[i] ?? ""}`);
}

// ── questions the agent asks (AskUserQuestion) ─────────────────────────────
let openQuestion: string | null = null;
let warnedUsage = false;
async function askQuestions(id: string, questions: AgentQuestion[]) {
  openQuestion = id;
  const answers: Record<string, string> = {};
  for (const q of questions) {
    if (openQuestion !== id) return; // answered in the app first
    console.log(`\n${c.bold(c.yellow(`? ${q.header ? `[${q.header}] ` : ""}${q.question}`))}`);
    q.options.forEach((o, i) => console.log(`  ${c.bold(String(i + 1))}. ${o.label}${o.description ? c.dim(` — ${o.description}`) : ""}`));
    const raw = (await ask(`  ${q.multiSelect ? "Numbers, comma-separated" : "Number"}, or type your own answer: `, id)).trim();
    if (openQuestion !== id) return;
    const nums = raw.split(/[,\s]+/).map(Number).filter((n) => n >= 1 && n <= q.options.length);
    answers[q.question] = nums.length && /^[\d,\s]+$/.test(raw) ? nums.map((n) => q.options[n - 1].label).join(", ") : raw || "(no answer, use your judgment)";
  }
  if (openQuestion !== id) return;
  if (bridge && tabId) await bridge.request("answer", { tabId, qid: id, answers });
  else engine.answer(id, answers);
}

// ── out of Claude usage: continue on GPT (standalone terminal) ──────────────
async function continueOnGpt(prompt: string, resetsAt: number | null) {
  if (!cfg.limits.fallback_to_gpt) {
    console.log(c.yellow(`Claude's usage limit is reached${resetsAt ? ` (resets ${formatReset(resetsAt)})` : ""}. Use /model ${cfg.models.gpt[0]} to keep going.`));
    return;
  }
  const history = engine.sessionId ? await engine.history(engine.sessionId).catch(() => []) : [];
  const transcript = history.slice(-30).map((h) => `${h.role}: ${h.text.slice(0, 1500)}`).join("\n");
  const gpt = new GptChat(cfg, cfg.models.gpt[0], render);
  gpt.seed(`You are continuing a task that was running on Claude until its usage limit was reached. Conversation so far:\n\n${transcript || "(none)"}\n\nPick up where it left off. The user's latest request follows.`);
  engine = gpt;
  console.log(c.yellow(`Claude's usage limit is reached${resetsAt ? ` (resets ${formatReset(resetsAt)})` : ""}. Continuing on ${cfg.models.gpt[0]} with your ChatGPT plan.`));
  gpt.send(prompt, "auto");
}

// ── /caffeinate: run the system's own keep-awake tool for as long as asked ──
let awake: { child: ChildProcess; status: CaffeinateStatus; timer?: NodeJS.Timeout } | null = null;
function awakeOff() {
  if (!awake) return;
  clearTimeout(awake.timer);
  awake.child.kill();
  awake = null;
}
process.on("exit", awakeOff);
function caffeinate(arg: string): string {
  const req = parseCaffeinate(arg);
  if (req.action === "status") return describeCaffeinate(awake?.status ?? { on: false, display: false, until: null });
  if (req.action === "off" || (req.action === "toggle" && awake)) {
    awakeOff();
    return describeCaffeinate({ on: false, display: false, until: null });
  }
  awakeOff();
  const secs = req.durationMs ? String(Math.ceil(req.durationMs / 1000)) : null;
  let cmd: string, args: string[];
  if (process.platform === "darwin") {
    // -i: no idle sleep; -d: screen stays on; -w: stop when this app exits; -t: for that long.
    cmd = "caffeinate";
    args = ["-i", ...(req.display ? ["-d"] : []), "-w", String(process.pid), ...(secs ? ["-t", secs] : [])];
  } else if (process.platform === "linux" && spawnSyncChild("which", ["systemd-inhibit"]).status === 0) {
    cmd = "systemd-inhibit";
    args = ["--what", req.display ? "idle:sleep" : "sleep", "--who", "multi-agent-harness", "--why", "/caffeinate", "sleep", secs ?? "infinity"];
  } else throw new Error("Caffeinate isn't available here (needs macOS, or systemd on Linux). The desktop app supports it everywhere.");
  const child = spawnChild(cmd, args, { stdio: "ignore" });
  const status: CaffeinateStatus = { on: true, display: req.display, until: req.durationMs ? Date.now() + req.durationMs : null };
  awake = { child, status };
  child.on("exit", () => {
    if (awake?.child === child) awake = null;
  });
  if (req.durationMs) awake.timer = setTimeout(awakeOff, req.durationMs);
  return describeCaffeinate(status);
}

// ── local engine (used when the app isn't running) ──────────────────────────
let engine: Engine =
  cfg.limits.fallback_to_gpt && isExhausted(harness.usage) && !flag("--model") ? new GptChat(cfg, cfg.models.gpt[0], render) : new ChatEngine(harness, render);
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
  console.log(c.green("Linked to the Multi-Agent Harness app") + c.dim(` · tab "${tab?.title ?? "New chat"}" · ${hello.cwd}`));
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
      case "/cloud": // runs in the app, on this tab
      case "/fast":
        send(arg ? `${cmd} ${arg}` : cmd);
        return true;
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
      case "/change":
        if (arg) await bridge.request("change", { tabId, text: arg });
        else console.log("Usage: /change <what to do differently>");
        return true;
      case "/context":
        printContext(await bridge.request<ContextInfo | null>("context", { tabId }));
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
      console.log(c.dim("Not linked to the app. Open Multi-Agent Harness and start this terminal again to share its tabs."));
      return true;
    case "/btw":
      if (!arg) console.log("Usage: /btw <question>");
      else void engine.btw(arg).then(printBtw);
      return true;
    case "/stop":
      if (busy) await engine.stop();
      else console.log(c.dim("Nothing running."));
      return true;
    case "/change":
      if (!arg) console.log("Usage: /change <what to do differently>. While a task runs, it adjusts at the next step without stopping.");
      else engine.change(arg, "terminal");
      return true;
    case "/context":
      printContext(await engine.context());
      return true;
    case "/docs": {
      const list = listDocs(process.cwd());
      if (!list.length) console.log(c.dim("No documents (.md, .txt, .pdf, .docx) in this folder."));
      list.slice(0, 40).forEach((d, i) => console.log(`${String(i + 1).padStart(2)}. ${d.prd ? c.cyan("[PRD] ") : ""}${d.rel}  ${c.dim(new Date(d.mtime).toLocaleDateString())}`));
      console.log(c.dim("\n/summarize <file or number> gives the main points."));
      return true;
    }
    case "/summarize": {
      const list = listDocs(process.cwd());
      const file = /^\d+$/.test(arg) ? list[Number(arg) - 1]?.path : arg;
      if (!file) {
        console.log("Usage: /summarize <file or number from /docs>");
        return true;
      }
      console.log(c.dim(`Summarizing ${file} with ${cfg.models.triage}…`));
      const sum = await summarizeDoc(harness, file, [process.cwd(), cfg.root]);
      console.log(`\n${c.bold(sum.tldr)}\n`);
      const section = (title: string, items: string[]) => items.length && console.log(`${c.bold(title)}\n${items.map((x) => `  • ${x}`).join("\n")}\n`);
      section("Main points", sum.points);
      section("Requirements", sum.requirements);
      section("Open questions", sum.open_questions);
      return true;
    }
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
    case "/computer": {
      if (arg.trim().toLowerCase() !== "test") return false;
      console.log(c.dim(`${cfg.models.gui} is taking a screenshot (computer use test)…`));
      const r = await runComputerUse(cfg, COMPUTER_TEST_PROMPT, { timeoutMinutes: 5 });
      console.log((r.ok ? c.green("Computer use works. ") : c.red("Computer use didn't work. ")) + r.text);
      console.log(c.dim(`Log: ${r.dir}`));
      return true;
    }
    case "/caffeinate":
    case "/caffinate": {
      try {
        console.log(caffeinate(arg));
      } catch (err) {
        console.log(c.red((err as Error).message));
      }
      return true;
    }
    case "/usage": {
      const u = bridge ? await bridge.request("usage") : await harness.refreshUsage();
      console.log(c.bold("Claude plan"));
      for (const l of describeUsage(u)) console.log(`  ${l}`);
      const codex = codexStatus(cfg.root);
      const gu = codex.ok ? await readCodexUsage(cfg.root, { warnAt: cfg.limits.warn_at }) : null;
      console.log(c.bold(`ChatGPT plan${gu?.plan ? ` · ${gu.plan}` : ""}`));
      if (gu) for (const l of describeUsage(gu).slice(0, -1)) console.log(`  ${l}`);
      else console.log(`  ${codex.ok ? `Signed in · ${cfg.models.gpt.join(", ")}. Codex didn't report usage.` : codex.detail}`);
      console.log(c.dim(cfg.limits.fallback_to_gpt ? `If Claude runs out, the task continues on ${cfg.models.gpt[0]}.` : "Automatic switch to GPT is off (limits.fallback_to_gpt)."));
      return true;
    }
    case "/connections": {
      const [sub, name, ...more] = arg.split(/\s+/);
      if (sub === "add" && name) {
        const saved = saveCustomServer(cfg, name, parseServerSpec(more.join(" ")));
        console.log(c.green(`Added ${saved}. Available from your next message.`));
        return true;
      }
      if (sub === "remove" && name) {
        console.log(removeCustomServer(cfg, name) ? c.green("Removed.") : c.red("Only servers you added can be removed; use /connections off <name> for others."));
        return true;
      }
      if ((sub === "off" || sub === "on") && name) {
        setDisabled(cfg, name, sub === "off");
        console.log(c.green(`${name} turned ${sub}.`));
        return true;
      }
      console.log(c.dim(sub === "reconnect" && name ? `Reconnecting ${name}…` : "Checking MCP servers…"));
      const list = await harness.connections(sub === "reconnect" ? name : undefined);
      const icon = (st: string) => (st === "connected" ? c.green("●") : st === "failed" ? c.red("●") : st === "disabled" ? c.dim("○") : c.yellow("●"));
      for (const x of list)
        console.log(
          `${icon(x.status)} ${x.name.padEnd(22)} ${c.dim(x.source.padEnd(9))} ${x.status === "connected" ? `${x.tools} tools` : x.status === "needs-auth" ? c.yellow("needs sign-in: run claude → /mcp") : x.status === "disabled" ? c.dim("off") : c.red(x.error ?? x.status)}`,
        );
      const codex = codexStatus(cfg.root);
      console.log(`${codex.ok ? c.green("●") : c.yellow("●")} ${"ChatGPT (Codex)".padEnd(22)} ${c.dim("account  ")} ${codex.detail}`);
      console.log(c.dim("\n/connections add <name> <url | command>  ·  remove <name>  ·  off|on <name>  ·  reconnect <name>"));
      return true;
    }
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
          `link:      ${bridge ? "linked to the Multi-Agent Harness app" : "standalone"}`,
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
    case "/fast":
      if (engine.kind !== "gpt") console.log("Fast mode isn't available on your Claude plan. It works with GPT models (--model gpt-6-astra), then /fast.");
      else {
        engine.fast = arg ? arg.toLowerCase() === "on" : !engine.fast;
        console.log(engine.fast ? `Fast mode on for ${engine.model}: about 2x speed, uses more of your ChatGPT plan.` : "Fast mode off.");
      }
      return true;
    case "/cloud":
      console.log("/cloud runs from the desktop app (or a terminal linked to it with npm start while the app is open): it needs the app's tabs and approval dialog.");
      return true;
    case "/learned": {
      const { learn, loadInstincts, effective } = await import("./instincts.js");
      const { bankFor } = await import("./projects.js");
      if (arg.trim() === "now") {
        console.log(c.dim("Reading recent chats…"));
        const r = await learn(cfg, (p) => harness.extractLessons(p));
        console.log(c.dim(`Read ${r.read} chat(s), ${r.lessons} lesson(s)${r.promoted.length ? `, promoted to all projects: ${r.promoted.join(", ")}` : ""}.`));
      }
      const { project, global } = loadInstincts(cfg, bankFor(cfg, harness.cwd));
      const rows = [...project.map((i) => [i, "project"] as const), ...global.map((i) => [i, "all"] as const)].sort((a, b) => effective(b[0]) - effective(a[0]));
      if (!rows.length) console.log(c.dim("Nothing learned yet in this project. It learns a few minutes after a chat goes quiet (in the app), or run /learned now."));
      for (const [i, where] of rows) console.log(`${String(Math.round(effective(i) * 100)).padStart(3)}%  ${i.trigger} → ${i.action}  ${c.dim(`[${where}]`)}`);
      if (rows.length) console.log(c.dim("Lessons at 70% and up are given to every new chat. Edit or delete them in the app (Memory → Learned)."));
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
  else engine.send(text, "terminal", text + mentionNote(parseMentions(text)));
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
    rl.on("line", (l) => answerAsk(l));
    await new Promise<void>((resolve) => {
      idleWaiter = resolve;
      engine.send(once, "terminal", once + mentionNote(parseMentions(once)));
    });
    process.exit(0);
  }

  console.log(
    c.bold("Multi-Agent Harness") +
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
    if (answerAsk(line)) return;
    void handle(line);
  });
  rl.on("close", () => process.exit(0));
  showPrompt();
}

void main();
