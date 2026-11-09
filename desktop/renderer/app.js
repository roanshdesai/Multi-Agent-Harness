/* global marked, DOMPurify */
"use strict";

const api = window.harness;
const $ = (id) => document.getElementById(id);
const thread = $("thread");
const input = $("input");

const AGENT_COLORS = ["advisor", "coder", "researcher", "summarizer", "gui-tester", "video", "designer", "verifier"];
let COMMANDS = [
  { name: "/new", description: "Start a new chat", group: "Chat" },
  { name: "/help", description: "All commands", group: "Harness" },
];
const SUGGESTIONS = [
  ["Research", "Compare the top 3 React animation libraries in my design library", "/research "],
  ["Code", "Build a landing page hero with Magic UI components", "/code "],
  ["Test", "Test my site's signup flow on mobile and desktop", "/test "],
  ["Advise", "Should this project use Postgres or SQLite?", "/advisor "],
];

let info = null;
let busy = false;
let liveBubble = null;
let liveText = "";
let renderTimer = null;
let lastAgentCard = null;
const agentCards = new Map();
let allChats = [];
let slashIndex = 0;

// ── helpers ────────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function md(text) {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
}
function atBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
}
function scroll(force) {
  if (force || atBottom()) thread.scrollTop = thread.scrollHeight;
}
function append(node) {
  const stick = atBottom();
  $("empty").hidden = true;
  thread.appendChild(node);
  if (stick) thread.scrollTop = thread.scrollHeight;
  return node;
}
function agentColor(name) {
  return AGENT_COLORS.includes(name) ? `var(--a-${name})` : "var(--a-other)";
}
function modelFor(agent) {
  if (!info) return "";
  const m = info.models;
  const map = { advisor: m.advisor, coder: m.coder, designer: m.coder, researcher: m.worker, summarizer: m.triage, "gui-tester": m.gui, video: m.video, verifier: m.verifier };
  return shortModel(map[agent] || "");
}
function shortModel(id) {
  if (/^gpt-/i.test(id)) return id.replace(/^gpt-(\d+)-?/i, "GPT-$1 ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  return id.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
}

// ── messages ───────────────────────────────────────────────────────────────
function addUser(text) {
  const m = el("div", "msg user");
  m.appendChild(el("div", "bubble", text));
  append(m);
  scroll(true);
}
function addAssistant(text) {
  const m = el("div", "msg assistant");
  const b = el("div", "bubble");
  b.innerHTML = md(text);
  m.appendChild(b);
  append(m);
}
function startLive() {
  const m = el("div", "msg assistant");
  liveBubble = el("div", "bubble streaming");
  m.appendChild(liveBubble);
  append(m);
  liveText = "";
}
function flushLive() {
  if (!liveBubble) return;
  const stick = atBottom();
  liveBubble.innerHTML = md(liveText);
  if (stick) scroll(true);
}
function endLive(finalText) {
  if (!liveBubble) {
    if (finalText) addAssistant(finalText);
    return;
  }
  clearTimeout(renderTimer);
  renderTimer = null;
  liveText = finalText ?? liveText;
  flushLive();
  liveBubble.classList.remove("streaming");
  liveBubble = null;
  liveText = "";
}
function addAgent(id, agent, description) {
  endLive();
  const wrap = el("div", "activity");
  const card = el("div", "agent-card");
  card.style.setProperty("--c", agentColor(agent));
  const head = el("div", "agent-head");
  const chip = el("span", "agent-chip");
  chip.style.setProperty("--c", agentColor(agent));
  chip.append(el("span", "", agent));
  const model = modelFor(agent);
  if (model) chip.append(el("span", "model", model));
  const spin = el("span", "spinner");
  spin.style.setProperty("--c", agentColor(agent));
  const count = el("span", "agent-count", "");
  head.append(chip, el("span", "agent-desc", description), count, spin);
  const tools = el("div", "agent-tools");
  head.onclick = () => card.classList.toggle("open");
  card.append(head, tools);
  wrap.appendChild(card);
  append(wrap);
  const entry = { card, tools, count, n: 0 };
  agentCards.set(id, entry);
  lastAgentCard = entry;
}
function addTool(name, summary, sub) {
  const row = el("div", "tool-row");
  row.append(el("b", "", name), document.createTextNode(` ${summary}`));
  if (sub && lastAgentCard) {
    lastAgentCard.tools.appendChild(row);
    lastAgentCard.n++;
    lastAgentCard.count.textContent = `${lastAgentCard.n} step${lastAgentCard.n === 1 ? "" : "s"}`;
    return;
  }
  // A main-thread tool means the previous agent handoff has returned.
  if (!sub) finishAgents();
  endLive();
  const w = el("div", "main-tool");
  w.appendChild(row);
  append(w);
}
function finishAgents() {
  for (const c of agentCards.values()) c.card.classList.add("done");
}
function addVerify(e) {
  endLive();
  const existing = thread.querySelector(".verify.running");
  if (e.status === "running") {
    finishAgents();
    const v = el("div", "verify running");
    const badge = el("span", "badge");
    const spin = el("span", "spinner");
    spin.style.setProperty("--c", "var(--a-verifier)");
    badge.append(spin, document.createTextNode(`Verifier checking${e.round > 1 ? ` (round ${e.round})` : ""}`));
    v.append(badge, el("span", "", modelFor("verifier")));
    append(v);
    return;
  }
  if (existing) existing.remove();
  const v = el("div", `verify ${e.status}`);
  const badge = el("span", "badge", e.status === "pass" ? "✓ Verified" : "✕ Verifier found problems, fixing");
  v.append(badge, el("span", "", modelFor("verifier")));
  append(v);
  if (e.status === "fail" && e.feedback) {
    const d = el("div", "verify-detail", e.feedback.slice(0, 3000));
    d.hidden = true;
    badge.onclick = () => (d.hidden = !d.hidden);
    append(d);
  }
}
function addNote(text, cls = "") {
  append(el("div", `note ${cls}`, text));
}

// ── events from the engine ─────────────────────────────────────────────────
api.onEvent((e) => {
  switch (e.type) {
    case "busy":
      setBusy(e.busy);
      if (!e.busy) {
        endLive();
        finishAgents();
        refreshChats();
      }
      break;
    case "session":
      markActive(e.id);
      break;
    case "text-delta":
      if (!liveBubble) startLive();
      liveText += e.text;
      if (!renderTimer)
        renderTimer = setTimeout(() => {
          renderTimer = null;
          flushLive();
        }, 60);
      break;
    case "text":
      endLive(e.text);
      break;
    case "agent":
      addAgent(e.id, e.agent, e.description);
      break;
    case "tool":
      addTool(e.name, e.summary, e.sub);
      break;
    case "verify":
      addVerify(e);
      break;
    case "queued":
      addUser(e.text);
      addNote("Queued. Runs after the current turn.");
      break;
    case "turn-end": {
      endLive();
      const bits = [`${e.numTurns} turn${e.numTurns === 1 ? "" : "s"}`];
      if (e.agents.length) bits.push(`agents: ${e.agents.join(", ")}`);
      if (info && !info.subscriptionOnly) bits.push(`~$${e.costUsd.toFixed(2)} API`);
      append(el("div", "meta", bits.join(" · ")));
      if (e.isError) addNote(`The turn ended with an error: ${e.error}`, "error");
      break;
    }
    case "error":
      endLive();
      addNote(e.message, "error");
      break;
    case "note":
      addNote(e.text, /^FAIL/.test(e.text) ? "error" : "");
      break;
  }
});

function setBusy(b) {
  busy = b;
  $("sendBtn").hidden = b;
  $("stopBtn").hidden = !b;
  $("hint").textContent = b
    ? "Working… you can queue another message, or use btw for a side question"
    : "Enter to send · Shift+Enter for a new line · only GitHub pushes ask for approval";
}

// ── chat list ──────────────────────────────────────────────────────────────
function groupLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = (today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function renderChats() {
  const q = $("chatSearch").value.trim().toLowerCase();
  const list = $("chatList");
  list.textContent = "";
  let group = "";
  for (const c of allChats.filter((c) => !q || c.title.toLowerCase().includes(q))) {
    const g = groupLabel(c.updated);
    if (g !== group) {
      group = g;
      list.appendChild(el("div", "chat-group", g));
    }
    const b = el("button", "chat-item", c.title || "Untitled");
    b.dataset.id = c.id;
    b.title = c.title;
    if (c.id === info?.sessionId) b.classList.add("active");
    b.onclick = () => openChat(c.id);
    list.appendChild(b);
  }
}
async function refreshChats() {
  allChats = await api.chats();
  renderChats();
  const cur = allChats.find((c) => c.id === info?.sessionId);
  $("chatTitle").textContent = cur?.title || (info?.sessionId ? "Chat" : "New chat");
}
function markActive(id) {
  if (info) info.sessionId = id;
  document.querySelectorAll(".chat-item").forEach((n) => n.classList.toggle("active", n.dataset.id === id));
}
function clearThread() {
  liveBubble = null;
  lastAgentCard = null;
  agentCards.clear();
  [...thread.children].forEach((n) => n.id !== "empty" && n.remove());
  $("empty").hidden = false;
}
function renderHistory(items) {
  clearThread();
  for (const it of items) {
    if (it.role === "user") addUser(it.text);
    else if (it.role === "assistant") addAssistant(it.text);
    else if (it.role === "agent") {
      const [agent, ...rest] = it.text.split(": ");
      addAgent(`h${Math.random()}`, agent, rest.join(": "));
    } else {
      const m = it.text.match(/^([^(]+)\((.*)\)$/s);
      addTool(m ? m[1] : it.text, m ? m[2] : "", false);
    }
  }
  finishAgents();
  scroll(true);
}
async function openChat(id) {
  if (busy) return addNote("Wait for the current turn to finish, or press Stop, before switching chats.");
  try {
    const history = await api.openChat(id);
    info.sessionId = id;
    renderHistory(history);
    markActive(id);
    $("chatTitle").textContent = allChats.find((c) => c.id === id)?.title || "Chat";
  } catch (err) {
    addNote(err.message, "error");
  }
}
async function newChat() {
  if (busy) return addNote("Wait for the current turn to finish, or press Stop, first.");
  await api.newChat();
  info.sessionId = null;
  clearThread();
  markActive(null);
  $("chatTitle").textContent = "New chat";
  input.focus();
}

// ── modals ─────────────────────────────────────────────────────────────────
function modal(title, body) {
  $("modalTitle").textContent = title;
  const b = $("modalBody");
  b.textContent = "";
  b.appendChild(body);
  $("modal").hidden = false;
}
$("modalClose").onclick = () => ($("modal").hidden = true);
$("modal").onclick = (e) => e.target.id === "modal" && ($("modal").hidden = true);

async function showDesign(q) {
  const links = await api.design(q);
  const box = el("div");
  if (!links.length) box.appendChild(el("p", "", "No matches."));
  for (const l of links) {
    const a = el("a", "link-row");
    a.href = l.url;
    a.target = "_blank";
    a.append(el("strong", "", l.title), el("small", "", `${l.notes ? l.notes + " · " : ""}${l.section ?? ""}`));
    box.appendChild(a);
  }
  const open = el("button", "ghost", "Edit UI-LINKS.md");
  open.onclick = () => api.openDesignLibrary();
  box.appendChild(open);
  modal(q ? `UI links: ${q}` : "UI links", box);
}
async function showAgents() {
  const box = el("div");
  for (const a of await api.agents()) {
    const r = el("div", "agent-row");
    const chip = el("span", "agent-chip");
    chip.style.setProperty("--c", agentColor(a.name));
    chip.append(el("span", "", a.name), el("span", "model", a.runsOn ? shortModel(a.runsOn.split(" ")[0]) : shortModel(a.model || "")));
    r.append(chip, el("p", "", a.description));
    box.appendChild(r);
  }
  modal("The team", box);
}
function showStatus() {
  const dl = el("dl", "kv");
  const row = (k, v) => dl.append(el("dt", "", k), el("dd", "", v));
  row("Billing", info.subscriptionOnly ? "Subscriptions only" : "API keys allowed (HARNESS_ALLOW_API=1)");
  row("Claude plan", info.auth.plan || info.auth.error || "unknown");
  row("GPT-6 Astra", info.codex.detail);
  row("Main model", info.mainModel);
  for (const [k, v] of Object.entries(info.models)) if (k !== "main") row(k, Array.isArray(v) ? v.join(" → ") : v);
  row("Verifier", info.verify ? "on" : "off");
  row("Folder", info.workspace);
  row("Plugins", info.plugins.join(", ") || "none (run npm run setup)");
  row("Not connected", info.mcpSkipped.join("; ") || "all configured");
  row("UI links", `${info.designCount} links`);
  const box = el("div");
  box.appendChild(dl);
  const cfg = el("button", "ghost", "Open harness.config.yaml");
  cfg.onclick = () => api.openConfig();
  box.appendChild(cfg);
  modal("Status", box);
}
function showHelp() {
  const box = el("div");
  let group = "";
  for (const c of COMMANDS) {
    if (c.group !== group) {
      group = c.group;
      box.appendChild(el("div", "chat-group", group));
    }
    const r = el("div", "slash-item");
    r.append(el("code", "", c.name + (c.args ? ` ${c.args}` : "")), el("span", "", c.description));
    box.appendChild(r);
  }
  box.appendChild(el("p", "", "Any other /command goes straight to the agent."));
  modal("Commands", box);
}

// ── btw ────────────────────────────────────────────────────────────────────
function openBtw() {
  $("btwPanel").hidden = false;
  $("btwInput").focus();
}
async function btw(q) {
  openBtw();
  const item = el("div");
  const a = el("div", "btw-a loading", "Thinking…");
  item.append(el("div", "btw-q", q), a);
  $("btwList").appendChild(item);
  try {
    const answer = await api.btw(q);
    a.classList.remove("loading");
    a.innerHTML = md(answer);
  } catch (err) {
    a.textContent = err.message;
  }
  $("btwList").scrollTop = $("btwList").scrollHeight;
}
$("btwBtn").onclick = openBtw;
$("btwClose").onclick = () => ($("btwPanel").hidden = true);
$("btwForm").onsubmit = (e) => {
  e.preventDefault();
  const q = $("btwInput").value.trim();
  if (!q) return;
  $("btwInput").value = "";
  btw(q);
};

// ── fork, rename, workspace ────────────────────────────────────────────────
async function fork(title) {
  try {
    await api.fork(title);
    addNote("Forked. The copy opened in a new window.");
  } catch (err) {
    addNote(err.message);
  }
}
$("forkBtn").onclick = () => fork();
$("chatTitle").ondblclick = async () => {
  if (!info.sessionId) return;
  const t = $("chatTitle");
  t.contentEditable = "true";
  t.focus();
  document.getSelection().selectAllChildren(t);
  const done = async (save) => {
    t.contentEditable = "false";
    t.onblur = t.onkeydown = null;
    if (save && t.textContent.trim()) await api.rename(t.textContent.trim());
    refreshChats();
  };
  t.onkeydown = (e) => {
    if (e.key === "Enter") (e.preventDefault(), done(true));
    if (e.key === "Escape") done(false);
  };
  t.onblur = () => done(true);
};
$("workspaceBtn").onclick = async () => {
  const ws = await api.pickWorkspace();
  if (!ws) return;
  info.workspace = ws;
  $("workspaceName").textContent = ws.split(/[\\/]/).pop() || ws;
  $("workspaceBtn").title = ws;
  await newChat();
  refreshChats();
};
$("verifyBtn").onclick = async () => {
  info.verify = await api.setVerify(!info.verify);
  $("verifyBtn").classList.toggle("on", info.verify);
};
$("modelSelect").onchange = async (e) => {
  info.mainModel = await api.setModel(e.target.value);
};

// ── composer & slash commands ──────────────────────────────────────────────
function autoSize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
  $("sendBtn").disabled = !input.value.trim();
}
function slashMatches() {
  const v = input.value.toLowerCase();
  if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return [];
  const q = v.slice(1);
  return COMMANDS.filter((c) => {
    const n = c.name.slice(1).toLowerCase();
    return n.startsWith(q) || n.split(":").pop().startsWith(q);
  }).slice(0, 60);
}
function renderSlash() {
  const items = slashMatches();
  const menu = $("slashMenu");
  menu.hidden = !items.length;
  menu.textContent = "";
  slashIndex = Math.min(slashIndex, Math.max(items.length - 1, 0));
  let group = "";
  items.forEach((c, i) => {
    if (c.group !== group) {
      group = c.group;
      menu.appendChild(el("div", "chat-group", group));
    }
    const r = el("div", `slash-item${i === slashIndex ? " sel" : ""}`);
    r.setAttribute("role", "option");
    r.title = `${c.name}${c.args ? ` ${c.args}` : ""}\n${c.description}`;
    r.append(el("code", "", c.name), el("span", "", (c.args ? `${c.args} · ` : "") + c.description));
    r.onmousedown = (e) => {
      e.preventDefault();
      pickSlash(c.name);
    };
    menu.appendChild(r);
  });
  menu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
function pickSlash(c) {
  input.value = c + " ";
  $("slashMenu").hidden = true;
  autoSize();
  input.focus();
}

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoSize();
  $("slashMenu").hidden = true;

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = { "/clear": "/new", "/quit": "/exit" }[rawCmd] || rawCmd;
  const arg = rest.join(" ");
  switch (cmd) {
    case "/new":
      return newChat();
    case "/exit":
      return window.close();
    case "/chats":
      $("chatSearch").focus();
      return refreshChats();
    case "/resume": {
      await refreshChats();
      const target = /^\d+$/.test(arg) ? allChats[Number(arg) - 1] : allChats.find((c) => c.id === arg || c.id.startsWith(arg));
      return target ? openChat(target.id) : addNote(arg ? "No such chat." : "Usage: /resume <id or number from /chats>");
    }
    case "/eval":
      return api.runEval(arg);
    case "/fork":
      return fork(arg);
    case "/btw":
      return arg ? btw(arg) : openBtw();
    case "/stop":
      return api.stop();
    case "/design":
      return showDesign(arg);
    case "/agents":
      return showAgents();
    case "/status":
      return showStatus();
    case "/help":
      return showHelp();
    case "/rename":
      if (arg) await api.rename(arg);
      return refreshChats();
    case "/verify":
      info.verify = await api.setVerify(arg !== "off");
      $("verifyBtn").classList.toggle("on", info.verify);
      return addNote(`Verifier ${info.verify ? "on" : "off"}.`);
    case "/model":
      if (arg) {
        info.mainModel = await api.setModel(arg);
        syncModelSelect();
      }
      return addNote(`Main model: ${info.mainModel}`);
  }
  if (!busy) addUser(text);
  api.send(text);
}

input.addEventListener("input", () => {
  autoSize();
  slashIndex = 0;
  renderSlash();
});
input.addEventListener("keydown", (e) => {
  const items = slashMatches();
  if (!$("slashMenu").hidden && items.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      return renderSlash();
    }
    if (e.key === "Tab" || (e.key === "Enter" && items[slashIndex].name !== input.value.trim())) {
      e.preventDefault();
      return pickSlash(items[slashIndex].name);
    }
    if (e.key === "Escape") return ($("slashMenu").hidden = true);
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
$("sendBtn").onclick = submit;
$("stopBtn").onclick = () => api.stop();
$("newChat").onclick = newChat;
$("chatSearch").oninput = renderChats;
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "n") (e.preventDefault(), newChat());
  if (mod && e.key.toLowerCase() === "k") (e.preventDefault(), $("chatSearch").focus());
  if (e.key === "Escape") $("modal").hidden = true;
});

// ── startup ────────────────────────────────────────────────────────────────
function syncModelSelect() {
  const sel = $("modelSelect");
  const options = [...new Set([info.mainModel, info.models.main, info.models.advisor, info.models.worker])];
  sel.textContent = "";
  for (const m of options) {
    const o = el("option", "", shortModel(m));
    o.value = m;
    sel.appendChild(o);
  }
  sel.value = info.mainModel;
}
function renderPlans() {
  const p = $("plans");
  p.textContent = "";
  const line = (ok, label) => {
    const r = el("div", "plan");
    r.append(el("span", `dot ${ok}`), el("span", "", label));
    p.appendChild(r);
  };
  if (info.subscriptionOnly) {
    line(info.auth.plan ? "ok" : "bad", `Claude ${info.auth.plan ? info.auth.plan.replace(/^./, (c) => c.toUpperCase()) : "not signed in"}`);
    line(info.codex.ok ? "ok" : "warn", info.codex.ok ? "ChatGPT (GPT-6 Astra)" : "ChatGPT not signed in");
  } else line("warn", "API billing allowed");
}
function renderSuggestions() {
  const box = $("suggestions");
  box.textContent = "";
  for (const [label, text, prefix] of SUGGESTIONS) {
    const b = el("button", "suggestion");
    b.append(el("strong", "", label), document.createTextNode(text));
    b.onclick = () => {
      input.value = prefix + text;
      autoSize();
      input.focus();
    };
    box.appendChild(b);
  }
}

async function start() {
  info = await api.init();
  if (Array.isArray(info.commands) && info.commands.length) COMMANDS = info.commands;
  document.body.classList.add(`platform-${info.platform === "darwin" ? "mac" : info.platform === "win32" ? "win" : "linux"}`);
  if (info.auth.error) {
    $("blockerMsg").textContent = info.auth.error.split("\n")[0];
    $("blocker").hidden = false;
  }
  $("workspaceName").textContent = info.workspace.split(/[\\/]/).pop() || info.workspace;
  $("workspaceBtn").title = info.workspace;
  $("verifyBtn").classList.toggle("on", info.verify);
  syncModelSelect();
  renderPlans();
  renderSuggestions();
  if (info.history.length) renderHistory(info.history);
  await refreshChats();
  autoSize();
}
$("retryAuth").onclick = async () => {
  await api.retryAuth();
  $("blocker").hidden = true;
  start();
};
start();
