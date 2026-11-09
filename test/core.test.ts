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
    { name: "init", description: "Create CLAUDE.md", argumentHint: "", builtin: true },
    { name: "btw", description: "a plugin trying to take /btw", argumentHint: "" },
  ]);
  const names = merged.map((c) => c.name);
  assert.equal(names.filter((n) => n === "/help").length, 1);
  assert.equal(merged.find((c) => c.name === "/btw")!.group, "Chat");
  assert.ok(names.includes("/superpowers:brainstorm"));
  assert.equal(merged.find((c) => c.name === "/review")!.group, "Skills & plugins");
  assert.equal(merged.find((c) => c.name === "/context")!.group, "Chat"); // the harness's own /context wins
  assert.equal(merged.filter((c) => c.name === "/context").length, 1);
  assert.equal(merged.find((c) => c.name === "/init")!.group, "Claude Code");
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
  // Not out: no reset time (stale), extra usage only, or one model's weekly window.
  assert.equal(isExhausted({ ...out, resetsAt: null }), false);
  assert.equal(isExhausted(toSnapshot({ status: "rejected", resetsAt: soon, rateLimitType: "overage", overageStatus: "rejected" } as any)), false);
  assert.equal(isExhausted(toSnapshot({ status: "rejected", resetsAt: soon, rateLimitType: "seven_day_opus", overageStatus: "rejected" } as any)), false);
  const { markWorking } = await import("../src/usage.js");
  assert.equal(isExhausted(markWorking(out)), false); // a real reply clears it
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

test("switching to GPT: a message sent while the history loads goes to GPT, after the hand-off", async () => {
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  const host = new Host(cfg, () => async () => "n");
  const events: any[] = [];
  host.listen((m) => m.type === "event" && events.push(m.event));
  const tab = host.createTab({ windowId: 1 });
  const claude = (host as any).get(tab.id).engine;
  let release!: () => void;
  claude.sessionId = "fake-session";
  claude.history = () => new Promise((r) => (release = () => r([{ role: "user", text: "earlier" }])));
  let claudeGot = false;
  claude.send = () => (claudeGot = true);
  const switching = (host as any).fallbackToGpt(tab.id, "finish the report");
  assert.equal(host.list()[0].kind, "gpt"); // swapped before the await
  host.send(tab.id, "and add a summary");
  release();
  await switching;
  const t0 = Date.now();
  while (events.filter((e) => e.type === "text").length < 2 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(claudeGot, false);
  const texts = events.filter((e) => e.type === "text").map((e) => e.text);
  assert.match(texts[0], /continuing a task[\s\S]*earlier[\s\S]*finish the report/); // seeded first
  assert.match(texts[1], /and add a summary/); // the gap message ran on GPT, after the hand-off
  delete process.env.HARNESS_CODEX_BIN;
});

test("workspace change: idle tabs move with fresh engines, busy tabs keep their folder", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  const host = new Host(cfg, () => async () => "n");
  const a = host.createTab({ windowId: 1 });
  const b = host.createTab({ windowId: 1, model: cfg.models.gpt[0] });
  const c = host.createTab({ windowId: 1 });
  const before = (host as any).get(c.id);
  Object.defineProperty(before.engine, "busy", { get: () => true });
  const oldDir = before.harness.cwd;
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  host.setWorkspace(dir);
  assert.equal((host as any).get(a.id).harness.cwd, dir);
  assert.equal((host as any).get(a.id).harness.options().cwd, dir);
  assert.equal((host as any).get(a.id).engine.cwd, dir);
  assert.equal((host as any).get(b.id).engine.cwd, dir); // GPT engine recreated in the new folder
  assert.equal((host as any).get(c.id).harness.cwd, oldDir); // busy tab untouched
  assert.equal((host as any).get(c.id).engine, before.engine);
  assert.equal(host.createTab({ windowId: 1 }).id && (host as any).get(`t${Number(c.id.slice(1)) + 1}`).harness.cwd, dir);
});

test("chats: listed from every folder; opening one runs it in its own folder", async () => {
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const { GptChat, listGptChats } = await import("../src/gpt-chat.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  const other = mkdtempSync(join(tmpdir(), "other-"));
  await new Promise<void>((resolve) => {
    const chat = new GptChat(cfg, cfg.models.gpt[0], (e) => e.type === "busy" && !e.busy && resolve(), other);
    chat.send("hello from another folder");
  });
  assert.equal(listGptChats(cfg, process.cwd()).length, 0);
  const all = listGptChats(cfg);
  assert.equal(all.length, 1);
  assert.equal(all[0].cwd, other);
  const host = new Host(cfg, () => async () => "n");
  const listed = (await host.chats()).find((c) => c.id === all[0].id);
  assert.ok(listed, "GPT chat from another folder is listed");
  const tab = host.createTab({ windowId: 1 });
  await host.openChat(tab.id, all[0].id, "x", other);
  assert.equal((host as any).get(tab.id).harness.cwd, other);
  assert.equal((host as any).get(tab.id).engine.cwd, other);
  delete process.env.HARNESS_CODEX_BIN;
});

test("usage on demand: plan windows from the SDK usage call", async () => {
  const { fromPlanUsage, isExhausted } = await import("../src/usage.js");
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const snap = fromPlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 0, resets_at: soon }, seven_day: { utilization: 42, resets_at: soon }, extra_usage: { is_enabled: false } } as any }, 0.8)!;
  assert.deepEqual(snap.windows.map((w) => [w.key, w.utilization]), [["five_hour", 0], ["seven_day", 0.42]]);
  assert.equal(isExhausted(snap), false);
  const out = fromPlanUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: soon } } }, 0.8)!;
  assert.equal(isExhausted(out), true);
  assert.equal(isExhausted(fromPlanUsage({ rate_limits_available: true, rate_limits: { seven_day_opus: { utilization: 100, resets_at: soon } } }, 0.8)), false);
  assert.equal(fromPlanUsage({ rate_limits_available: false, rate_limits: null }), null); // API key: nothing to show
});

test("models: saved back to the config file, comments kept, applied at once", async () => {
  const { loadConfig, saveModels } = await import("../src/config.js");
  const { readFileSync, copyFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  copyFileSync(join(process.cwd(), "harness.config.yaml"), join(dir, "harness.config.yaml"));
  const cfg = loadConfig(dir);
  saveModels(cfg, { coder: "claude-test-coder", gpt: ["gpt-a", "gpt-b"], claude: [] });
  assert.equal(cfg.models.coder, "claude-test-coder");
  const again = loadConfig(dir);
  assert.equal(again.models.coder, "claude-test-coder");
  assert.deepEqual(again.models.gpt, ["gpt-a", "gpt-b"]);
  assert.match(readFileSync(join(dir, "harness.config.yaml"), "utf8"), /# orchestrator/); // comments survive
  assert.throws(() => saveModels(cfg, { main: " " }), /Pick a model/);
  assert.throws(() => saveModels(cfg, { gpt: [] }), /at least one GPT/);
});

test("@apps: a named app reaches the model as an instruction; the shown message stays as typed", async () => {
  const { mentionAlias, mentionNote, parseMentions, mcpPrefix } = await import("../src/engine.js");
  assert.equal(mentionAlias("plugin:small-business:stripe"), "stripe");
  assert.equal(mentionAlias("claude.ai Slack"), "slack");
  assert.equal(mentionAlias("pally"), "pally");
  assert.equal(mcpPrefix("plugin:small-business:stripe"), "mcp__plugin_small-business_stripe__");
  assert.deepEqual(parseMentions("ask @pally and @slack, not me@example.com"), ["pally", "slack"]);
  assert.equal(mentionNote([]), "");
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  const host = new Host(cfg, () => async () => "n");
  const tab = host.createTab({ windowId: 1 });
  const got: any[] = [];
  (host as any).get(tab.id).engine.send = (text: string, source: string, prompt: string) => got.push({ text, prompt });
  host.send(tab.id, "post the summary @slack", "app", ["claude.ai Slack"]);
  assert.equal(got[0].text, "post the summary @slack");
  assert.match(got[0].prompt, /claude\.ai Slack \(tools named mcp__claude_ai_Slack__\*\)/);
  delete process.env.HARNESS_CODEX_BIN;
});

test("ChatGPT usage: read from Codex's app server and shown like Claude's", async () => {
  const { fromCodexRateLimits, readCodexUsage } = await import("../src/codex-usage.js");
  const { isExhausted } = await import("../src/usage.js");
  const now = Math.floor(Date.now() / 1000);
  const snap = fromCodexRateLimits({ rateLimits: { planType: "pro", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: now + 60 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: now + 600 } } }, 0.8)!;
  assert.deepEqual(snap.windows.map((w) => [w.label, w.utilization]), [["5-hour limit", 0.25], ["Weekly limit", 0.5]]);
  assert.equal(snap.plan, "pro");
  assert.equal(isExhausted(snap), false);
  assert.equal(isExhausted(fromCodexRateLimits({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now + 60 } } })), true);
  assert.equal(fromCodexRateLimits({ rateLimits: {} }), null);
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const live = await readCodexUsage(process.cwd(), { timeoutMs: 8000 });
  assert.ok(live, "the fake Codex answered");
  assert.deepEqual(live!.windows.map((w) => Math.round((w.utilization ?? 0) * 100)), [12, 40]);
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "does-not-exist");
  assert.equal(await readCodexUsage(process.cwd(), { timeoutMs: 3000 }), null); // missing Codex: no crash, no data
  delete process.env.HARNESS_CODEX_BIN;
});

test("token stats: daily totals from Claude Code and Codex transcripts (plain and .zst)", async () => {
  const { tokenStats } = await import("../src/token-stats.js");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const cdir = join(home, "claude", "projects", "-proj");
  mkdirSync(join(cdir, "sess1", "subagents"), { recursive: true });
  const day1 = "2026-03-02T10:00:00.000Z";
  const msg = (id: string, ts: string, model: string, inp: number, cw: number, cr: number, out: number) =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage: { input_tokens: inp, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out } } });
  writeFileSync(join(cdir, "sess1.jsonl"), [
    JSON.stringify({ type: "user", timestamp: day1 }),
    msg("m1", day1, "claude-opus-5-5", 10, 100, 5000, 50), // split reply: same id twice, counted once
    msg("m1", day1, "claude-opus-5-5", 10, 100, 5000, 50),
    msg("m2", day1, "claude-sonnet-5-5", 5, 0, 0, 20),
    msg("m3", day1, "<synthetic>", 999, 0, 0, 999),
  ].join("\n"));
  writeFileSync(join(cdir, "sess1", "subagents", "agent-1.jsonl"), msg("s1", day1, "claude-fable-5-1", 1, 0, 0, 9));
  const gdir = join(home, "codex", "sessions", "2026", "03", "03");
  mkdirSync(gdir, { recursive: true });
  const ts2 = "2026-03-03T09:00:00.000Z";
  writeFileSync(join(gdir, "rollout-1.jsonl"), [
    JSON.stringify({ timestamp: ts2, type: "turn_context", payload: { model: "gpt-6-astra" } }),
    JSON.stringify({ timestamp: ts2, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 } } } }),
    JSON.stringify({ timestamp: ts2, type: "event_msg", payload: { type: "token_count", info: null } }),
  ].join("\n"));
  // Codex compresses older rollouts to .jsonl.zst; those count too.
  const { zstdCompressSync } = await import("node:zlib");
  writeFileSync(join(gdir, "rollout-2.jsonl.zst"), zstdCompressSync(Buffer.from([
    JSON.stringify({ timestamp: ts2, type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
    JSON.stringify({ timestamp: ts2, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 50 } } } }),
  ].join("\n"))));
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  process.env.CODEX_HOME = join(home, "codex");
  const root = mkdtempSync(join(tmpdir(), "root-"));
  try {
    const s = await tokenStats(root);
    const d1 = Object.keys(s.days).find((d) => s.days[d].claude)!;
    assert.deepEqual(s.days[d1].claude, { "claude-opus-5-5": 160, "claude-sonnet-5-5": 25, "claude-fable-5-1": 10 });
    const d2 = Object.keys(s.days).find((d) => s.days[d].gpt)!;
    assert.deepEqual(s.days[d2].gpt, { "gpt-6-astra": 500, "gpt-6.1-sol": 250 });
    assert.deepEqual(s.sessions, { claude: 1, gpt: 2 }); // subagent file isn't a separate session
    const again = await tokenStats(root); // second read comes from the cache
    assert.deepEqual(again.days, s.days);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  }
});

test("context hand-off: past the threshold a context.md is written once, and a new chat starts from it", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const { existsSync, readFileSync } = await import("node:fs");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  cfg.context = { handoff_at: 0.8 };
  const host = new Host(cfg, () => async () => "n");
  const events: any[] = [];
  host.listen((m) => m.type === "event" && events.push({ tab: m.tabId, ...m.event }));
  const tab = host.createTab({ windowId: 1, title: "Big task" });
  const t = (host as any).get(tab.id);
  const prompts: string[] = [];
  t.harness.run = async (p: string) => (prompts.push(p), { text: "# Context\n\nGoal: ship it.", isError: false, sessionId: "s1", numTurns: 1, costUsd: 0, agentsUsed: [] });
  t.engine.sessionId = "s1";
  t.engine.lastContext = { percentage: 70 };
  (t.engine as any).maybeHandoff();
  assert.equal(prompts.length, 0, "below the threshold: nothing");
  t.engine.lastContext = { percentage: 83 };
  (t.engine as any).maybeHandoff();
  (t.engine as any).maybeHandoff(); // only once per chat
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(prompts.length, 1);
  const ready = events.find((e) => e.type === "handoff" && e.status === "ready");
  assert.ok(ready && ready.auto && ready.percent === 83);
  assert.ok(existsSync(ready.file) && /Goal: ship it/.test(readFileSync(ready.file, "utf8")));

  const next = host.continueInNewChat(tab.id, ready.file);
  assert.notEqual(next.id, tab.id);
  const n = (host as any).get(next.id);
  assert.equal(n.harness.cwd, t.harness.cwd);
  let sent = "";
  n.harness.run = async (p: string) => ((sent = p), { text: "ok", isError: false, sessionId: "s2", numTurns: 1, costUsd: 0, agentsUsed: [] });
  n.harness.verifyEnabled = false;
  n.engine.send("carry on", "app");
  await new Promise((r) => setTimeout(r, 50));
  assert.match(sent, /continues an earlier one \("Big task"\)/);
  assert.match(sent, /Goal: ship it[\s\S]*carry on$/);
  assert.throws(() => host.continueInNewChat(tab.id, "/etc/passwd"), /isn't available/);
  cfg.context = { handoff_at: 0 }; // 0 turns it off
  t.engine.sessionId = "s3";
  (t.engine as any).maybeHandoff();
  assert.equal(prompts.length, 1);
});

test("/remote: an MCP client can list tabs, send a task and read the reply; wrong links are refused", async () => {
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  const { loadConfig } = await import("../src/config.js");
  const { Host } = await import("../src/host.js");
  const { RemoteControl } = await import("../src/remote.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  cfg.remote = { port: 0 }; // any free port
  const host = new Host(cfg, () => async () => "n");
  const gptTab = host.createTab({ windowId: 1, model: cfg.models.gpt[0] });
  const rc = new RemoteControl(cfg, host);
  const st = await rc.start();
  try {
    const url = st.localUrl!;
    const call = async (u: string, body: object) => {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
      return { status: r.status, json: r.status === 200 ? await r.json() : null };
    };
    assert.equal((await call(url.replace(/[^/]+$/, "wrong-token-xxxxxxxxxxxxxxxxxxxxxxxx"), { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status, 404);
    const init = await call(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(init.json.result.serverInfo.name, "multi-agent-harness");
    assert.equal((await call(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const tools = await call(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(tools.json.result.tools.map((t: any) => t.name), ["list_tabs", "send_message", "get_reply", "read_chat", "answer_question", "stop", "usage"]);
    const tool = async (name: string, args: object = {}) => (await call(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })).json.result;
    assert.match((await tool("list_tabs")).content[0].text, new RegExp(gptTab.id));
    assert.match((await tool("send_message", { text: "hello from pally", tab_id: gptTab.id })).content[0].text, /Sent to tab/);
    const reply = await tool("get_reply", { tab_id: gptTab.id, wait_seconds: 10 });
    assert.match(reply.content[0].text, /hello from pally/);
    assert.match((await tool("read_chat", { tab_id: gptTab.id })).content[0].text, /user: hello from pally/);
    assert.equal((await tool("answer_question", { tab_id: gptTab.id, answer: "x" })).isError, true); // nothing waiting
    const old = url;
    const rotated = rc.rotate();
    assert.notEqual(rotated.localUrl, old);
    assert.equal((await call(old, { jsonrpc: "2.0", id: 9, method: "ping" })).status, 404);
  } finally {
    await rc.stop();
    delete process.env.HARNESS_CODEX_BIN;
  }
});

test("/caffeinate: parses toggle, durations, display and off", async () => {
  const { parseCaffeinate, describeCaffeinate } = await import("../src/caffeinate.js");
  assert.deepEqual(parseCaffeinate(""), { action: "toggle", durationMs: null, display: false });
  assert.deepEqual(parseCaffeinate("2h"), { action: "on", durationMs: 7_200_000, display: false });
  assert.deepEqual(parseCaffeinate("90m display"), { action: "on", durationMs: 5_400_000, display: true });
  assert.equal(parseCaffeinate("45").durationMs, 2_700_000); // bare number = minutes
  assert.equal(parseCaffeinate("off").action, "off");
  assert.throws(() => parseCaffeinate("forever"), /Usage/);
  assert.match(describeCaffeinate({ on: true, display: false, until: null }), /until you run \/caffeinate off/);
  assert.match(describeCaffeinate({ on: true, display: true, until: 1000 + 90 * 60_000 }, 1000), /computer and screen awake for 1h 30m/);
  assert.match(describeCaffeinate({ on: false, display: false, until: null }), /can sleep/);
});

test("computer use: only allowed apps, run through Codex with the UI model", async () => {
  const { computerArgs, runComputerUse, COMPUTER_TEST_PROMPT } = await import("../src/tools/computer.js");
  const { loadConfig } = await import("../src/config.js");
  const cfg = loadConfig(process.cwd());
  cfg.root = mkdtempSync(join(tmpdir(), "root-"));
  cfg.computer_use = { default_app_access: "deny", apps: { "com.google.Chrome": "allow", "bad id; rm -rf": "allow" }, browser: { access: "allow", uploads: "deny" } };
  const a = computerArgs(cfg).join(" ");
  assert.match(a, /computer_use\.default_app_access="deny"/);
  assert.match(a, /computer_use\.macos\.bundle_ids=\{"com\.google\.Chrome"="allow"\}/); // one inline table (Codex splits dotted keys)
  assert.doesNotMatch(a, /rm -rf/); // only bundle ids get through
  assert.match(a, /browser_use\.default_origin_policy\.uploads="deny"/);
  cfg.computer_use = {};
  assert.match(computerArgs(cfg).join(" "), /default_app_access="deny"/); // deny unless allowed
  process.env.HARNESS_CODEX_BIN = join(process.cwd(), "test", "fixtures", "fake-codex.mjs");
  try {
    const r = await runComputerUse(cfg, COMPUTER_TEST_PROMPT, { timeoutMinutes: 1 });
    assert.ok(r.ok, r.text);
    assert.match(r.text, new RegExp(`echo\\(${cfg.models.gui}\\): This is a permissions check`));
    const { helperDown } = await import("../src/tools/computer.js");
    const toml = '[mcp_servers.computer-use]\ncommand = "x"\n\n[mcp_servers.palmier-pro]\nurl = "http://127.0.0.1:19789/mcp"\n';
    // The line Codex 0.167 prints when an HTTP MCP server is down:
    const log = 'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (http://127.0.0.1:19789/mcp)")))';
    assert.match(helperDown(log, toml)!, /MCP server "palmier-pro" \(127\.0\.0\.1:19789\) isn't running/);
    assert.match(helperDown(log)!, /Nothing answered on 127\.0\.0\.1:19789/);
    const { approvalHint } = await import("../src/tools/computer.js");
    assert.match(approvalHint("the tool reported: “Computer Use was not approved to use Finder.”")!, /isn't approved for Finder yet\. Approve it once in the ChatGPT app/);
    assert.equal(approvalHint("OK Google Drive"), null);
    assert.equal(helperDown("all good"), null);
    const { engine } = { engine: await import("../src/engine.js") };
    assert.equal(engine.expandShortcut("/computer", "test"), null);
    assert.match(engine.expandShortcut("/computer", "open Safari")!, /computer_use tool/);
  } finally {
    delete process.env.HARNESS_CODEX_BIN;
  }
});

test("docs: finds documents, spots PRDs, refuses paths outside the project", async () => {
  const { listDocs, isPrd, readDoc, safePath } = await import("../src/docs.js");
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  mkdirSync(join(dir, "specs"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "README.md"), "# Hello");
  writeFileSync(join(dir, "specs", "checkout-prd.md"), "# Checkout");
  writeFileSync(join(dir, "notes.txt"), "Product Requirements Document\nGoals: ...");
  writeFileSync(join(dir, "node_modules", "skip.md"), "x");
  writeFileSync(join(dir, "code.ts"), "x");
  const list = listDocs(dir, new Map([[join(dir, "README.md"), "edited"]]));
  assert.deepEqual(list.map((d) => d.rel).sort(), ["README.md", "notes.txt", join("specs", "checkout-prd.md")].sort());
  assert.equal(list[0].rel, "README.md"); // touched by an agent comes first
  assert.ok(isPrd(join(dir, "specs", "checkout-prd.md")));
  assert.ok(isPrd(join(dir, "notes.txt")));
  assert.ok(!isPrd(join(dir, "README.md")));
  assert.equal(readDoc(join(dir, "README.md"), [dir]).text, "# Hello");
  assert.throws(() => safePath("/etc/passwd", [dir]), /outside the project/);
  assert.throws(() => safePath(join(dir, "..", "escape.md"), [dir]), /outside the project|doesn't exist/);
  assert.throws(() => safePath(join(dir, "code.ts"), [dir]), /Only documents/); // not a document type
});

test("/change: steering text is sent into a running turn, otherwise sent normally", async () => {
  const { ChatEngine, changeNote } = await import("../src/engine.js");
  const events: any[] = [];
  const fakeHarness: any = { cfg: { root: mkdtempSync(join(tmpdir(), "r-")) }, mainModel: "claude-opus-5-5" };
  const engine = new ChatEngine(fakeHarness, (e) => events.push(e));
  const steered: string[] = [];
  (engine as any).busy = true;
  (engine as any).steer = (t: string) => (steered.push(t), true);
  engine.change("use DELTA instead", "terminal");
  assert.deepEqual(steered, [changeNote("use DELTA instead")]);
  assert.deepEqual(events.pop(), { type: "user", text: "use DELTA instead", source: "terminal", change: true });
  // idle: becomes a normal message
  (engine as any).busy = false;
  (engine as any).steer = null;
  let sent = "";
  (engine as any).runTurn = async (t: string) => (sent = t);
  engine.change("do it this way");
  assert.equal(sent, "do it this way");
});

test("push guard: chained, multi-line, global-option, --all and gh merges can't slip past", async () => {
  const { pushTargets } = await import("../src/guards.js");
  const cwd = process.cwd();
  assert.deepEqual(pushTargets("git push origin feat && git push origin main", cwd), ["feat", "main"]);
  assert.deepEqual(pushTargets("echo hi\ngit push origin main", cwd), ["main"]);
  assert.deepEqual(pushTargets("git -c core.x=1 push origin main", cwd), ["main"]);
  assert.ok(pushTargets("git push --all origin", cwd)!.includes("main"));
  assert.deepEqual(pushTargets("git push origin feat:main", cwd), ["main"]);
  assert.equal(pushTargets("git status && ls", cwd), null);
  const hook = pushApprovalHook(cfg, async () => "y").hooks[0];
  const run = async (command: string) =>
    ((await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd } as any, "t", { signal })) as any)?.hookSpecificOutput?.permissionDecision ?? "none";
  assert.equal(await run("git push origin feat && git push origin main"), "deny");
  assert.equal(await run("gh pr merge 3 --admin"), "deny");
  assert.equal(await run("gh pr create --fill"), "allow"); // asked, user said y
  assert.equal(await run("gh pr list"), "none");
});

test("Hindsight: a native macOS install is found by its launch agents", async () => {
  const { hindsightLaunchAgents } = await import("../src/memory.js");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.deepEqual(hindsightLaunchAgents(home), []);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "io.vectorize.hindsight-api.plist"), "<plist/>");
  assert.deepEqual(hindsightLaunchAgents(home), ["io.vectorize.hindsight-api"]);
});
