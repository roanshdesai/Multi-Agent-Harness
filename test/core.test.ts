import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushApprovalHook } from "../src/guards.js";
import { loadDesignLinks, searchDesignLinks } from "../src/tools/design-library.js";
import { discoverPlugins } from "../src/session.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = { approvals: { github_push: "ask", protected_branches: ["main", "master"] } } as unknown as HarnessConfig;
const signal = new AbortController().signal;

async function decide(tool_name: string, tool_input: unknown, answer = "y") {
  let asked = false;
  const hook = pushApprovalHook(cfg, async () => ((asked = true), answer)).hooks[0];
  const out: any = await hook(
    { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: process.cwd() } as any,
    "t",
    { signal },
  );
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? "none", asked };
}

test("non-push commands pass through untouched", async () => {
  assert.deepEqual(await decide("Bash", { command: "git status && ls" }), { decision: "none", asked: false });
});

test("push to a feature branch asks the user", async () => {
  assert.deepEqual(await decide("Bash", { command: "git push -u origin feat/x" }), { decision: "allow", asked: true });
  assert.deepEqual(await decide("Bash", { command: "git push origin feat/x" }, "n"), { decision: "deny", asked: true });
});

test("push to main/master is blocked without asking", async () => {
  for (const command of ["git push origin main", "git push origin HEAD:main", "git push -f origin master"]) {
    assert.deepEqual(await decide("Bash", { command }), { decision: "deny", asked: false }, command);
  }
});

test("branch names containing 'main' are not treated as main", async () => {
  assert.equal((await decide("Bash", { command: "git push origin feature-main" })).decision, "allow");
});

test("GitHub MCP writes ask; writes to main are blocked", async () => {
  assert.deepEqual(await decide("mcp__github__create_pull_request", { head: "feat/x", base: "main" }), { decision: "allow", asked: true });
  assert.deepEqual(await decide("mcp__github__push_files", { branch: "main" }), { decision: "deny", asked: false });
  assert.deepEqual(await decide("mcp__github__get_file_contents", { path: "x" }), { decision: "none", asked: false });
});

test("design library: yaml, plain URL lists, and ranked search", () => {
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  writeFileSync(join(dir, "a.yaml"), "links:\n  - {title: Linear, url: https://linear.app, tags: [dashboard, dark]}\n  - {title: Stripe, url: https://stripe.com, tags: [landing]}\n");
  writeFileSync(join(dir, "b.txt"), "https://a.com\nnot a link\nhttps://b.com\n");
  const links = loadDesignLinks(join(dir, "a.yaml"));
  assert.equal(searchDesignLinks(links, "dark dashboard")[0].title, "Linear");
  assert.equal(loadDesignLinks(join(dir, "b.txt")).length, 2);
});

test("plugin discovery finds nested .claude-plugin dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "pl-"));
  for (const p of ["superpowers", "claude-mem/plugin"]) {
    mkdirSync(join(root, p, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, p, ".claude-plugin", "plugin.json"), "{}");
  }
  const found = discoverPlugins(root).map((p) => p.path.replace(root + "/", "")).sort();
  assert.deepEqual(found, ["claude-mem/plugin", "superpowers"]);
});

test("UI-LINKS.md: parses sections, notes, and hides Swift-only refs for web work", async () => {
  const { filterByPlatform } = await import("../src/tools/design-library.js");
  const links = loadDesignLinks(join(process.cwd(), "design-library", "UI-LINKS.md"));
  assert.equal(links.length, 30);
  const magic = links.find((l) => l.title === "Magic UI")!;
  assert.equal(magic.url, "https://magicui.design/docs/components");
  assert.match(magic.notes ?? "", /animated React\/Tailwind/);
  assert.equal(magic.swiftOnly, false);
  assert.ok(links.find((l) => l.title === "joogps/Glur")!.swiftOnly);
  assert.ok(links.find((l) => l.title.startsWith("Apple Human"))!.swiftOnly);

  const web = filterByPlatform(links, "web");
  assert.equal(web.length, 17);
  assert.ok(!web.some((l) => l.swiftOnly));
  assert.equal(filterByPlatform(links, "web", "swiftui toast").length, 30); // query mentions Swift
  assert.deepEqual(searchDesignLinks(filterByPlatform(links, "swift"), "toasts").slice(0, 2).map((l) => l.title).sort(), ["exyte/PopupView", "omaralbeik/Drops"]);
  assert.ok(searchDesignLinks(web, "smooth scrolling").some((l) => l.title === "Lenis"));
});

test("subscription-only: accepts a Claude plan login, rejects API billing", async () => {
  const { assertClaudeSubscription, subscriptionEnv } = await import("../src/subscription.js");
  assert.equal(assertClaudeSubscription({ subscriptionType: "max", apiKeySource: "none", apiProvider: "firstParty" }), "max");
  assert.equal(assertClaudeSubscription({ subscriptionType: "pro", apiKeySource: "none" }), "pro");
  for (const bad of [
    { subscriptionType: "Claude API", apiKeySource: "none", apiProvider: "firstParty" },
    { subscriptionType: "max", apiKeySource: "ANTHROPIC_API_KEY" },
    { subscriptionType: "max", apiKeySource: "/login managed key" },
    { subscriptionType: "max", apiKeySource: "none", apiProvider: "bedrock" },
    { apiKeySource: "none" },
  ] as const) {
    assert.throws(() => assertClaudeSubscription(bad as any), /not signed in with a subscription/, JSON.stringify(bad));
  }
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.OPENAI_API_KEY = "sk-test";
  const env = subscriptionEnv();
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.ok(env.PATH);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

test("commands: harness commands win, plugin commands added, only useful built-ins kept", async () => {
  const { mergeCommands, canonical, HARNESS_COMMANDS } = await import("../src/commands.js");
  const merged = mergeCommands([
    { name: "superpowers:brainstorm", description: "Brainstorm before building", argumentHint: "" },
    { name: "review", description: "gstack review", argumentHint: "[branch]" },
    { name: "help", description: "Claude Code help", argumentHint: "", builtin: true },
    { name: "login", description: "Sign in", argumentHint: "", builtin: true },
    { name: "context", description: "Show context usage", argumentHint: "", builtin: true },
    { name: "btw", description: "a plugin trying to take /btw", argumentHint: "" },
  ]);
  const names = merged.map((c) => c.name);
  assert.equal(names.filter((n) => n === "/help").length, 1);
  assert.equal(merged.find((c) => c.name === "/btw")!.group, "Chat");
  assert.ok(names.includes("/superpowers:brainstorm"));
  assert.equal(merged.find((c) => c.name === "/review")!.group, "Skills & plugins");
  assert.equal(merged.find((c) => c.name === "/context")!.group, "Claude Code");
  assert.ok(!names.includes("/login"));
  assert.equal(names.slice(0, HARNESS_COMMANDS.length).join(), HARNESS_COMMANDS.map((c) => c.name).join());
  assert.equal(canonical("/clear"), "/new");
  assert.equal(canonical("/quit"), "/exit");
});

// ── subagents, GPT chats, bridge ───────────────────────────────────────────
function tmpCfg() {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  return {
    root: dir,
    subagents_file: join(dir, "subagents.yaml"),
    models: { main: "claude-opus-5-5", advisor: "claude-fable-5-1", worker: "claude-sonnet-5-5", gpt: ["gpt-6-astra", "gpt-6.1-sol"], gui: "gpt-6-astra", image: "gpt-6.1-sol" },
    auth: { subscription_only: true },
  } as unknown as HarnessConfig;
}

test("subagents: save, replace by name, remove; GPT ones get a Sonnet coordinator", async () => {
  const { upsertSubagents, loadSubagents, removeSubagent, toAgentDefinition } = await import("../src/subagents.js");
  const cfg = tmpCfg();
  upsertSubagents(cfg, [
    { name: "SEO Writer", description: "Writes SEO copy", engine: "claude", model: "claude-sonnet-5-5", prompt: "Write." },
    { name: "copy-critic", description: "Critiques copy", engine: "claude", model: "gpt-6-astra", prompt: "Critique." },
  ]);
  let list = loadSubagents(cfg);
  assert.deepEqual(list.map((a) => a.name), ["seo-writer", "copy-critic"]);
  assert.equal(list[1].engine, "gpt"); // a GPT model forces the gpt engine
  const gptDef = toAgentDefinition(list[1], cfg);
  assert.equal(gptDef.model, "claude-sonnet-5-5");
  assert.match(gptDef.prompt, /mcp__harness__ask_gpt/);
  assert.match(gptDef.prompt, /gpt-6-astra/);
  upsertSubagents(cfg, [{ name: "seo-writer", description: "v2", engine: "claude", model: "claude-sonnet-5-5", prompt: "Write v2." }]);
  list = loadSubagents(cfg);
  assert.equal(list.length, 2);
  assert.equal(list.find((a) => a.name === "seo-writer")!.description, "v2");
  assert.ok(removeSubagent(cfg, "seo-writer"));
  assert.ok(!removeSubagent(cfg, "nope"));
  assert.deepEqual(loadSubagents(cfg).map((a) => a.name), ["copy-critic"]);
});

test("GPT chat: runs through Codex, maps events, keeps a transcript, resumes the thread", async () => {
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const { GptChat, listGptChats } = await import("../src/gpt-chat.js");
  const cfg = tmpCfg();
  const events: any[] = [];
  const chat = new GptChat(cfg, "gpt-6-astra", (e) => events.push(e), cfg.root);
  const idle = () => new Promise<void>((r) => { const t = setInterval(() => { if (!chat.busy) { clearInterval(t); r(); } }, 20); });
  chat.send("hello", "terminal");
  await idle();
  assert.equal(chat.sessionId, "thread-123");
  assert.deepEqual(events.find((e) => e.type === "user"), { type: "user", text: "hello", queued: false, source: "terminal" });
  assert.ok(events.some((e) => e.type === "tool" && e.name === "Shell" && e.summary === "ls -la"));
  assert.ok(events.some((e) => e.type === "text" && e.text === "echo(gpt-6-astra): hello"));
  assert.ok(events.some((e) => e.type === "turn-end" && !e.isError));

  chat.send("again");
  await idle();
  const texts = events.filter((e) => e.type === "text").map((e) => e.text);
  assert.equal(texts.at(-1), "echo(gpt-6-astra): again");
  assert.equal(chat.sessionId, "thread-123"); // resumed, same thread
  const listed = listGptChats(cfg, cfg.root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "hello");
  const history = await chat.history("thread-123");
  assert.deepEqual(history.filter((h) => h.role !== "tool").map((h) => h.role), ["user", "assistant", "user", "assistant"]);
  delete process.env.HARNESS_CODEX_BIN;
});

test("bridge: a terminal client gets tab lists and events, and its sends reach the host", async () => {
  const { startBridge, connectBridge, bridgePath } = await import("../src/bridge.js");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const listeners = new Set<any>();
  const sent: any[] = [];
  const fakeHost: any = {
    activeTab: "t1",
    list: () => [{ id: "t1", windowId: 1, kind: "claude", model: "claude-opus-5-5", sessionId: null, title: "New chat", busy: false, verify: true }],
    listen: (fn: any) => (listeners.add(fn), () => listeners.delete(fn)),
    send: (tabId: string, text: string, source: string) => {
      sent.push({ tabId, text, source });
      for (const l of listeners) l({ type: "event", tabId, event: { type: "user", text, source } });
    },
    history: async () => [],
  };
  const server = startBridge(fakeHost, () => {}, () => 1);
  await new Promise((r) => server.once("listening", r));
  assert.ok(bridgePath().startsWith(home));
  const client = await connectBridge(1000);
  assert.ok(client);
  const pushes: any[] = [];
  client!.onPush((m) => pushes.push(m));
  const hello = await client!.request("hello");
  assert.equal(hello.active, "t1");
  await client!.request("send", { tabId: "t1", text: "from the terminal" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent, [{ tabId: "t1", text: "from the terminal", source: "terminal" }]);
  assert.ok(pushes.some((m) => m.type === "event" && m.event.text === "from the terminal"));
  await assert.rejects(client!.request("bogus"), /Unknown op/);
  client!.close();
  server.close();
  process.env.HOME = oldHome;
});

// ── usage, connections, GPT handoff ────────────────────────────────────────
test("usage: reads the plan windows and knows when Claude is out", async () => {
  const { toSnapshot, isExhausted, describeUsage } = await import("../src/usage.js");
  const soon = Math.floor(Date.now() / 1000) + 3600;
  const ok = toSnapshot({ status: "allowed", resetsAt: soon, rateLimitType: "five_hour", overageStatus: "rejected",
    unifiedWindows: { five_hour: { utilization: 0.72, resetsAt: soon, status: "allowed" }, seven_day: { utilization: 0.23, resetsAt: soon + 86400, status: "allowed" } } } as any);
  assert.deepEqual(ok.windows.map((w) => [w.key, w.utilization]), [["five_hour", 0.72], ["seven_day", 0.23]]);
  assert.equal(ok.windows[0].resetsAt, soon * 1000);
  assert.equal(isExhausted(ok), false);
  const out = toSnapshot({ status: "rejected", resetsAt: soon, rateLimitType: "five_hour", overageStatus: "rejected" } as any);
  assert.equal(isExhausted(out), true);
  assert.equal(isExhausted({ ...out, overage: "allowed" }), false); // extra usage still available
  assert.equal(isExhausted({ ...out, resetsAt: Date.now() - 1000 }), false); // already reset
  assert.match(describeUsage(out).join("\n"), /New work goes to GPT/);
});

test("connections: add servers from a URL or a command; /mcp and /apps open connections", async () => {
  const { parseServerSpec, saveCustomServer, loadCustomServers, removeCustomServer, setDisabled, loadDisabled } = await import("../src/connections.js");
  assert.deepEqual(parseServerSpec("https://mcp.notion.com/mcp Authorization=Bearer_x"), { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer_x" } });
  assert.deepEqual(parseServerSpec('npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Docs"'), { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/My Docs"] });
  assert.throws(() => parseServerSpec("   "));
  const cfg = tmpCfg();
  assert.equal(saveCustomServer(cfg, "My Notion", parseServerSpec("https://x.example/mcp")), "my-notion");
  assert.throws(() => saveCustomServer(cfg, "harness", parseServerSpec("https://x")));
  assert.deepEqual(Object.keys(loadCustomServers(cfg)), ["my-notion"]);
  setDisabled(cfg, "slack", true);
  assert.deepEqual(loadDisabled(cfg), ["slack"]);
  setDisabled(cfg, "slack", false);
  assert.deepEqual(loadDisabled(cfg), []);
  assert.ok(removeCustomServer(cfg, "my-notion"));
  const { canonical } = await import("../src/commands.js");
  assert.equal(canonical("/mcp"), "/connections");
  assert.equal(canonical("/apps"), "/connections");
});

test("out of Claude usage: the tab carries the conversation over to GPT and re-sends the request", async () => {
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  const host = new Host(cfg, () => async () => "n");
  const events: any[] = [];
  host.listen((m) => m.type === "event" && events.push(m.event));
  const tab = host.createTab({ windowId: 1 });
  assert.equal(tab.kind, "claude");
  await (host as any).fallbackToGpt(tab.id, "finish the report");
  const after = host.list().find((t) => t.id === tab.id)!;
  assert.equal(after.kind, "gpt");
  const t0 = Date.now();
  while (host.list()[0].busy || !events.some((e) => e.type === "text")) {
    if (Date.now() - t0 > 5000) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(events.some((e) => e.type === "note" && /usage limit is reached/.test(e.text)));
  assert.ok(events.some((e) => e.type === "user" && e.text === "finish the report" && e.source === "auto"));
  const text = events.find((e) => e.type === "text")?.text ?? "";
  assert.match(text, /continuing a task that was running on Claude/); // context was carried over
  assert.match(text, /finish the report/);
  delete process.env.HARNESS_CODEX_BIN;
});
