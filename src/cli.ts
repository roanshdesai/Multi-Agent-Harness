#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  forkSession,
  listSessions,
  renameSession,
  type Options,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config.js";
import { Harness, type TurnResult } from "./session.js";
import { buildAgents } from "./agents.js";
import { loadDesignLinks, searchDesignLinks, filterByPlatform } from "./tools/design-library.js";
import { openInNewTerminal, resumeCommand } from "./terminal.js";
import { runEvals } from "./eval.js";

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
const stateFile = join(cfg.root, ".harness", "last-session");
mkdirSync(join(cfg.root, ".harness"), { recursive: true });

// ── input plumbing: one readline shared by the prompt, approvals and /btw ───
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

let sessionId: string | undefined = flag("--resume");
if (argv.includes("--continue") && existsSync(stateFile)) sessionId = readFileSync(stateFile, "utf8").trim();
let busy = false;
let current: Query | null = null;
const queue: string[] = [];

// ── rendering ───────────────────────────────────────────────────────────────
function summarizeInput(input: any): string {
  const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? input?.prompt ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 100);
}

function render(prefix = "") {
  return (m: SDKMessage) => {
    if (m.type === "system" && m.subtype === "init" && !prefix) {
      sessionId = m.session_id;
    }
    if (m.type !== "assistant") return;
    const sub = m.parent_tool_use_id !== null;
    for (const b of m.message.content) {
      if (b.type === "text" && !sub && b.text.trim()) {
        console.log(`${prefix}${b.text}\n`);
      } else if (b.type === "tool_use") {
        const input = b.input as any;
        const label =
          b.name === "Agent" || b.name === "Task"
            ? c.cyan(`⇢ ${input?.subagent_type ?? "agent"}: ${String(input?.description ?? "").slice(0, 80)}`)
            : c.dim(`${sub ? "   ↳ " : "⏺ "}${b.name}(${summarizeInput(input)})`);
        console.log(prefix + label);
      }
    }
  };
}

// ── main turn with verifier loop ────────────────────────────────────────────
async function runMain(prompt: string) {
  busy = true;
  try {
    const opts: Partial<Options> = sessionId ? { resume: sessionId } : {};
    let r: TurnResult = await harness.run(prompt, opts, { onMessage: render(), onQuery: (q) => (current = q) });
    sessionId = r.sessionId || sessionId;

    // Verify substantive work (anything that used tools).
    if (harness.verifyEnabled && !r.isError && (r.agentsUsed.length > 0 || r.numTurns > 2) && sessionId && !prompt.startsWith("/")) {
      for (let round = 1; round <= cfg.verify.max_rounds; round++) {
        console.log(c.dim(`… verifier (${cfg.models.verifier}) checking, round ${round}`));
        const v = await harness.verify(sessionId);
        if (v.pass) {
          console.log(c.green("✔ verifier: PASS\n"));
          break;
        }
        console.log(c.red("✘ verifier: FAIL\n") + c.dim(v.feedback.slice(0, 1500)) + "\n");
        r = await harness.run(
          `An independent verifier reviewed your last answer and found problems:\n\n${v.feedback}\n\nFix them (delegate as usual), then give the corrected final answer.`,
          { resume: sessionId },
          { onMessage: render(), onQuery: (q) => (current = q) },
        );
      }
    }
    if (r.isError) console.log(c.red(`(turn ended with an error: ${r.text})`));
    console.log(c.dim(`[${r.numTurns} turns · $${r.costUsd.toFixed(2)}${r.agentsUsed.length ? ` · agents: ${[...new Set(r.agentsUsed)].join(", ")}` : ""}]`));
  } catch (err) {
    console.log(c.red(`Error: ${(err as Error).message}`));
  } finally {
    if (sessionId) writeFileSync(stateFile, sessionId);
    current = null;
    busy = false;
    const next = queue.shift();
    if (next) void handle(next);
    else showPrompt();
  }
}

/** /btw — side question on a throwaway fork; can run while a turn is in progress. */
async function btw(question: string) {
  const opts: Partial<Options> = {
    persistSession: false,
    maxTurns: 6,
    disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash", "Agent", "mcp__github__*", "mcp__slack__*", "mcp__outlook__*"],
    ...(sessionId ? { resume: sessionId, forkSession: true } : {}),
  };
  const r = await harness.run(
    `(Side question from the user. Answer briefly from what you already know; do not start or change any work.)\n\n${question}`,
    opts,
  );
  console.log(c.cyan("\n┌─ btw ─────────────────────────────"));
  console.log(r.text.split("\n").map((l) => c.cyan("│ ") + l).join("\n"));
  console.log(c.cyan("└───────────────────────────────────\n"));
  if (!busy) showPrompt();
}

// ── slash commands ──────────────────────────────────────────────────────────
const HELP = `
${c.bold("Chat")}
  /new, /clear            start a fresh chat
  /fork [title]           fork this chat into a NEW terminal window (add --here to switch in place)
  /btw <question>         quick side question; doesn't touch the main chat (works mid-turn)
  /chats                  list recent chats        /resume <id|#>   reopen one
  /rename <title>         name this chat           /compact         compact context
  /stop                   interrupt the running turn
${c.bold("Delegation shortcuts")}
  /advisor <q>            ask the Fable advisor     /code <task>     Fable coder
  /research <q>           Sonnet researcher         /test <url> <checklist>   GUI test (GPT-6 Astra)
  /video <task>           Opus video agent          /design [query]  search your UI links (add 'swift' for SwiftUI)
  /remember <fact>        save to Hindsight         /recall <q>      search memory
${c.bold("Harness")}
  /status  /agents  /model [id]  /verify on|off  /eval [filter]  /help  /exit
Any other /command (e.g. superpowers or gstack skills like /review, /qa, /ship) is passed to the agent.
`;

async function command(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  const delegate = (text: string) => (busy ? queue.push(text) : void runMain(text));

  switch (cmd) {
    case "/help":
      console.log(HELP);
      return true;
    case "/exit":
    case "/quit":
      process.exit(0);
    case "/new":
    case "/clear":
      sessionId = undefined;
      console.log(c.dim("Started a new chat."));
      return true;
    case "/btw":
      if (!arg) console.log("Usage: /btw <question>");
      else void btw(arg);
      return true;
    case "/stop":
      if (current) await current.interrupt();
      else console.log(c.dim("Nothing running."));
      return true;
    case "/fork": {
      if (!sessionId) {
        console.log(c.dim("Nothing to fork yet; send a message first."));
        return true;
      }
      const here = rest.includes("--here");
      const title = rest.filter((r) => r !== "--here").join(" ") || undefined;
      const { sessionId: forkId } = await forkSession(sessionId, { title });
      if (here) {
        sessionId = forkId;
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
      const list = await listSessions({ dir: process.cwd(), limit: 20 });
      list.forEach((s, i) =>
        console.log(
          `${String(i + 1).padStart(2)}. ${s.sessionId === sessionId ? c.green("●") : " "} ${s.customTitle ?? s.summary}`.slice(0, 110) +
            c.dim(`  ${new Date(s.lastModified).toLocaleString()}  ${s.sessionId}`),
        ),
      );
      return true;
    }
    case "/resume": {
      if (/^\d+$/.test(arg)) {
        const list = await listSessions({ dir: process.cwd(), limit: 50 });
        sessionId = list[Number(arg) - 1]?.sessionId;
      } else sessionId = arg || (existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : undefined);
      console.log(sessionId ? c.green(`Resumed ${sessionId}`) : c.red("No such chat."));
      return true;
    }
    case "/rename":
      if (sessionId && arg) {
        await renameSession(sessionId, arg);
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
          `chat:      ${sessionId ?? "(new)"}`,
          `models:    ${Object.entries(cfg.models).map(([k, v]) => `${k}=${v}`).join("  ")}`,
          `main now:  ${harness.mainModel}`,
          `verifier:  ${harness.verifyEnabled ? "on" : "off"}`,
          `plugins:   ${harness.plugins.map((p) => p.path.split("/").pop()).join(", ") || "(none — run scripts/setup.sh)"}`,
          `mcp off:   ${harness.mcpSkipped.join("; ") || "(all enabled servers configured)"}`,
          `design:    ${loadDesignLinks(cfg.design_library).length} links in ${cfg.design_library}`,
        ].join("\n"),
      );
      return true;
    case "/agents":
      for (const [name, a] of Object.entries(buildAgents(cfg))) console.log(`${c.cyan(name.padEnd(12))} ${c.dim(a.model ?? "")}  ${a.description}`);
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
      await runEvals(harness, arg);
      return true;
    case "/advisor":
      delegate(`Consult the "advisor" agent on this and report its recommendation: ${arg}`);
      return true;
    case "/code":
      delegate(`Delegate this coding task to the "coder" agent, verify it, and report back: ${arg}`);
      return true;
    case "/research":
      delegate(`Use "researcher" agents (in parallel if it splits) to research: ${arg}`);
      return true;
    case "/test":
      delegate(`Have the "gui-tester" agent test this: ${arg}`);
      return true;
    case "/video":
      delegate(`Delegate to the "video" agent: ${arg}`);
      return true;
    case "/remember":
      delegate(`Store this in long-term memory (Hindsight retain), confirm briefly: ${arg}`);
      return true;
    case "/recall":
      delegate(`Search long-term memory (Hindsight recall/reflect, and claude-mem if available) for: ${arg}`);
      return true;
    default:
      return false; // unknown → pass through to the agent (plugin/skill commands)
  }
}

async function handle(line: string) {
  const text = line.trim();
  if (!text) return showPrompt();
  if (text.startsWith("/") && (await command(text))) {
    if (!busy) showPrompt();
    return;
  }
  if (busy) {
    queue.push(text);
    console.log(c.dim(`(queued — runs after the current turn; use /btw for a side question)`));
    return;
  }
  await runMain(text);
}

function showPrompt() {
  if (process.stdin.isTTY) rl.setPrompt(c.bold(`${sessionId ? "›" : "+"} `)), rl.prompt();
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
    await runMain(once);
    process.exit(0);
  }

  console.log(
    c.bold("Agent harness") +
      c.dim(`  main ${harness.mainModel} · advisor/coder ${cfg.models.advisor} · workers ${cfg.models.worker} · gui ${cfg.models.gui}`),
  );
  if (sessionId) console.log(c.dim(`Resumed chat ${sessionId}`));
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
