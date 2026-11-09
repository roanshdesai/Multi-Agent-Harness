/* global marked, DOMPurify */
"use strict";

const api = window.harness;
const $ = (id) => document.getElementById(id);
const viewsEl = $("views");
const input = $("input");

let info = null;
let COMMANDS = [];
let allChats = [];
let docs = [];
let agents = [];
let connState = [];
let memStatus = null;
let usageState = null;
let slashIndex = 0;
let pane = "projects";
/** Projects in groups, each with its own folder, chats and Hindsight memory. */
let projectsState = { groups: [], current: null, count: 0 };
const collapsed = new Set();

/** tabId → tab state. Chat tabs mirror the host; document and memory tabs are local. */
const tabs = new Map();
let order = [];
let active = null;
let localSeq = 0;

// ── small helpers ──────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const ICONS = {
  chat: "M4 5h16v11H8l-4 4z",
  doc: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  db: "M5 6c0 1.7 3.1 3 7 3s7-1.3 7-3-3.1-3-7-3-7 1.3-7 3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chevD: "M6 9l6 6 6-6",
  chevR: "M9 6l6 6-6 6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  ext: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  terminal: "M4 17l6-6-6-6M12 19h8",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  q: "M12 18h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3",
  plug: "M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5",
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
};
const icon = (name, cls = "") => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  if (cls) s.setAttribute("class", cls);
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name] ?? name);
  s.appendChild(p);
  return s;
};
const md = (text) => DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
const isGpt = (m) => /^gpt-/i.test(m || "");
/** Last part of a folder path, for chat rows. */
function folderName(p) {
  return (p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}
function shortModel(id = "") {
  if (/^gpt-/i.test(id)) return id.replace(/^gpt-([\d.]+)-?/i, "GPT-$1 ").replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
  return id.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
}
function modelFor(agent) {
  if (!info) return "";
  const m = info.models;
  if (info.runsOn?.[agent]) return shortModel(info.runsOn[agent].split(" ")[0]);
  const map = { advisor: m.advisor, coder: m.coder, designer: m.coder, researcher: m.worker, summarizer: m.triage, video: m.video, verifier: m.verifier };
  return shortModel(map[agent] || agents.find((a) => a.name === agent)?.model || "");
}
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
function fmtTime(at) {
  if (!at) return "";
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
function groupLabel(ts) {
  const diff = (new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return new Date(ts).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// ── tabs ───────────────────────────────────────────────────────────────────
function cur() {
  return tabs.get(active);
}
function makeView(full = false) {
  const view = el("section", `view${full ? " full" : ""}`);
  view.hidden = true;
  viewsEl.appendChild(view);
  return view;
}
// Empty tab: a compact readout of the team and recent work, not a greeting page.
function welcome() {
  const w = el("div", "welcome");
  const path = info?.workspace ?? "";
  const head = el("div", "w-head");
  head.append(el("span", "label-mono", "Ready"), el("span", "w-path mono", path));
  w.append(head);

  const m = info?.models ?? {};
  const roster = el("div", "roster");
  const roles = [
    ["Plans", m.main],
    ["Code + review", m.coder],
    ["Design", m.designer ?? m.coder],
    ["Research", m.worker],
    ["Images", m.image],
    ["UI tests", m.gui],
  ];
  for (const a of agents.filter((x) => x.custom)) roles.push([a.name, a.runsOn?.split(" ")[0] ?? a.model ?? m.main]);
  for (const [role, model] of roles) {
    if (!model) continue;
    const r = el("div", "r-row");
    r.append(el("span", `mark${/^gpt-/i.test(model) ? " gpt" : ""}`), el("span", "r-role", role), el("span", "r-model mono", shortModel(model)));
    roster.append(r);
  }

  const cols = el("div", "cols");
  const start = el("div", "w-col");
  start.append(el("h3", "label-mono", "Quick start"));
  const items = [
    ["/research", "Research a question", "/research "],
    ["/code", "Build or fix something", "/code "],
    ["/image", "Make an image", "/image "],
    ["/subagents", "Suggest subagents for this project", "/subagents "],
  ];
  for (const [cmd, label, p] of items) {
    const b = el("button", "starter");
    b.append(el("code", "", cmd), el("span", "txt", label));
    b.onclick = () => {
      if (p === "/subagents ") return showSubagents();
      input.value = p;
      autoSize();
      input.focus();
    };
    start.append(b);
  }
  const recent = el("div", "w-col");
  recent.append(el("h3", "label-mono", "Recent"));
  if (!allChats.length) recent.append(el("p", "muted", "No chats yet."));
  for (const c of allChats.slice(0, 6)) {
    const b = el("button", "starter");
    b.append(el("span", `mark${c.kind === "gpt" ? " gpt" : ""}`), el("span", "txt", c.title || "Untitled"), el("small", "", `${folderName(c.cwd)} · ${groupLabel(c.updated)}`));
    b.onclick = () => openChat(c);
    recent.append(b);
  }
  cols.append(start, recent);
  w.append(roster, cols, statsPanel());
  return w;
}

// ── token usage over time (like Claude Code's /stats), under the start screen ──
let tokenData = null; // from api.tokenStats()
let statsTab = "all"; // all | claude | gpt
let statsLoading = null;
function loadTokenStats(force) {
  if (statsLoading && !force) return statsLoading;
  statsLoading = api.tokenStats().then((d) => {
    tokenData = d;
    refreshWelcomes();
    return d;
  }).catch(() => null);
  return statsLoading;
}
const fmtBig = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Reference texts for the comparison line, in tokens (about 1.33 tokens per word).
const BOOKS = [
  ["The Great Gatsby", 63e3],
  ["Pride and Prejudice", 162e3],
  ["Moby-Dick", 276e3],
  ["The Lord of the Rings", 640e3],
  ["War and Peace", 780e3],
  ["the complete works of Shakespeare", 1.17e6],
  ["the Harry Potter series", 1.44e6],
  ["In Search of Lost Time", 1.7e6],
  ["the Encyclopaedia Britannica", 59e6],
  ["English Wikipedia", 6e9],
];
/** Per-day totals for the chosen tab, plus per-model totals. */
function statsFor(tab) {
  const perDay = new Map();
  const perModel = new Map();
  for (const [day, kinds] of Object.entries(tokenData?.days ?? {})) {
    let t = 0;
    for (const [kind, models] of Object.entries(kinds)) {
      if (tab !== "all" && kind !== tab) continue;
      for (const [m, n] of Object.entries(models)) {
        t += n;
        perModel.set(m, (perModel.get(m) ?? 0) + n);
      }
    }
    if (t) perDay.set(day, t);
  }
  return { perDay, perModel };
}
function streaks(perDay) {
  const days = [...perDay.keys()].sort();
  let longest = 0, run = 0, prev = null;
  for (const d of days) {
    const t = new Date(`${d}T12:00:00`);
    run = prev && (t - prev) / 864e5 < 1.5 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  let current = 0;
  const c = new Date();
  if (!perDay.has(dayKey(c))) c.setDate(c.getDate() - 1); // today not used yet: count from yesterday
  while (perDay.has(dayKey(c))) {
    current++;
    c.setDate(c.getDate() - 1);
  }
  return { longest, current };
}
function statsPanel() {
  const p = el("section", "stats");
  const head = el("div", "stats-head");
  head.appendChild(el("h3", "label-mono", "Token usage"));
  const tabsEl = el("div", "stats-tabs");
  for (const [k, label] of [["all", "All"], ["claude", "Claude"], ["gpt", "ChatGPT"]]) {
    const b = el("button", `stats-tab${statsTab === k ? " on" : ""}`, label);
    b.onclick = () => ((statsTab = k), refreshWelcomes());
    tabsEl.appendChild(b);
  }
  head.appendChild(tabsEl);
  p.appendChild(head);
  if (!tokenData) {
    p.appendChild(el("p", "muted", "Reading your Claude Code and Codex history…"));
    void loadTokenStats();
  api.caffeinate("status").then(showAwake).catch(() => {});
    return p;
  }
  const { perDay, perModel } = statsFor(statsTab);
  const total = [...perDay.values()].reduce((a, b) => a + b, 0);
  if (!total) {
    p.appendChild(el("p", "muted", statsTab === "gpt" ? "No ChatGPT (Codex) usage found on this computer yet." : statsTab === "claude" ? "No Claude Code usage found on this computer yet." : "No usage found on this computer yet."));
    return p;
  }
  const { longest, current } = streaks(perDay);
  const top = [...perModel].sort((a, b) => b[1] - a[1])[0];
  const peak = [...perDay].sort((a, b) => b[1] - a[1])[0];
  const sessions = statsTab === "all" ? tokenData.sessions.claude + tokenData.sessions.gpt : tokenData.sessions[statsTab];
  const tiles = el("div", "stats-tiles");
  const tile = (k, v, sub) => {
    const t = el("div", "tile");
    t.append(el("span", "tk label-mono", k), el("span", "tv mono", v));
    if (sub) t.appendChild(el("span", "ts", sub));
    tiles.appendChild(t);
  };
  tile("Total tokens", fmtBig(total), "input + output");
  tiles.lastChild.title = "Input, cache writes and output tokens. Cache reads (the same context re-read every turn) aren't counted.";
  tile("Sessions", String(sessions));
  tile("Active days", String(perDay.size));
  tile("Current streak", `${current} day${current === 1 ? "" : "s"}`);
  tile("Longest streak", `${longest} day${longest === 1 ? "" : "s"}`);
  tile("Top model", shortModel(top[0]), fmtBig(top[1]));
  tile("Busiest day", new Date(`${peak[0]}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }), fmtBig(peak[1]));
  p.appendChild(tiles);

  // calendar grid: one column per week (last 53), one row per weekday
  const grid = el("div", `heat ${statsTab}`);
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7 * 52 - start.getDay());
  // Shade relative to the busiest day (square-root scale so quieter days still show).
  const max = Math.max(...perDay.values());
  const months = el("div", "heat-months");
  let lastMonth = -1;
  for (let d = new Date(start), col = 0; d <= end; col++) {
    const week = el("div", "heat-col");
    if (d.getMonth() !== lastMonth) {
      const m = el("span", "", d.toLocaleDateString(undefined, { month: "short" }));
      m.style.gridColumn = String(col + 1);
      months.appendChild(m);
      lastMonth = d.getMonth();
    }
    for (let r = 0; r < 7; r++, d.setDate(d.getDate() + 1)) {
      const n = perDay.get(dayKey(d)) ?? 0;
      const lvl = d > end ? -1 : !n ? 0 : Math.max(1, Math.ceil(4 * Math.sqrt(n / max)));
      const cell = el("i", lvl < 0 ? "future" : `l${lvl}`);
      if (lvl >= 0) cell.title = `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${n ? `${fmtBig(n)} tokens` : "no usage"}`;
      week.appendChild(cell);
    }
    grid.appendChild(week);
  }
  const wrap = el("div", "heat-wrap");
  wrap.append(months, grid);
  const legend = el("div", "heat-legend");
  legend.append(el("span", "", "Less"));
  for (let i = 0; i <= 4; i++) legend.appendChild(el("i", `l${i}`));
  legend.append(el("span", "", "More"));
  p.append(wrap, legend);

  // the comparison line
  const book = [...BOOKS].reverse().find(([, n]) => total >= n);
  const line = book
    ? `You've used about ${Math.floor(total / book[1]).toLocaleString()}× more tokens than ${book[0]}.`
    : `You've used about ${Math.round((total / BOOKS[0][1]) * 100)}% of the tokens in ${BOOKS[0][0]}.`;
  p.appendChild(el("p", "stats-fact", line));
  return p;
}
/** Redraw every empty tab's start screen (after the folder, chats or agents change). */
function refreshWelcomes() {
  for (const s of tabs.values())
    if (s.type === "chat" && s.empty) {
      const fresh = welcome();
      fresh.hidden = s.empty.hidden;
      s.empty.replaceWith(fresh);
      s.empty = fresh;
    }
}
function ensureChatTab(t) {
  let s = tabs.get(t.id);
  if (!s) {
    const view = makeView();
    const empty = welcome();
    view.appendChild(empty);
    s = { id: t.id, type: "chat", view, empty, live: null, liveText: "", timer: null, lastAgent: null, agents: new Map(), loaded: false, context: null };
    tabs.set(t.id, s);
    order.push(t.id);
  }
  s.info = t;
  return s;
}
function addLocalTab(type, title, extra) {
  const id = `${type}${++localSeq}`;
  const s = { id, type, title, view: makeView(true), ...extra };
  tabs.set(id, s);
  order.push(id);
  return s;
}
function renderTabs() {
  const bar = $("tabs");
  bar.textContent = "";
  order.forEach((id, idx) => {
    const s = tabs.get(id);
    if (!s) return;
    const chat = s.type === "chat";
    const b = el("div", `tab${id === active ? " active" : ""}${chat && s.info.busy ? " busy" : ""}`);
    b.setAttribute("role", "tab");
    b.tabIndex = 0;
    b.append(el("span", "n", String(idx + 1).padStart(2, "0")));
    b.append(el("span", `mark${chat ? (isGpt(s.info.model) ? " gpt" : "") : s.type === "doc" ? " doc" : " mem"}`));
    b.append(el("span", "t", chat ? s.info.title : s.title));
    const x = el("button", "x", "×");
    x.title = "Close (⌘W)";
    x.onclick = (e) => (e.stopPropagation(), closeTab(id));
    b.append(x);
    b.title = chat ? `${s.info.title} · ${shortModel(s.info.model)}${s.info.busy ? " · working" : ""}` : s.title;
    b.onclick = () => activate(id);
    b.onauxclick = (e) => e.button === 1 && closeTab(id);
    bar.appendChild(b);
  });
  bar.querySelector(".tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}
function activate(id) {
  if (!tabs.has(id)) return;
  active = id;
  for (const [tid, s] of tabs) s.view.hidden = tid !== id;
  const s = tabs.get(id);
  if (s.type === "chat") {
    void api.focusTab(id);
    if (!s.loaded) {
      s.loaded = true;
      api.tabHistory(id).then((items) => items.length && renderHistory(s, items));
    }
    if (!s.context && s.info.sessionId) api.context(id).then((c) => c && ((s.context = c), renderStatus()));
  }
  renderTabs();
  syncToolbar();
  renderPane();
  input.focus();
}
async function newTab(opts = {}) {
  const t = await api.newTab(opts);
  const s = ensureChatTab(t);
  if (!opts.chatId) s.loaded = true;
  activate(t.id);
  return s;
}
function removeTabLocal(id) {
  const s = tabs.get(id);
  if (!s) return;
  s.view.remove();
  tabs.delete(id);
  order = order.filter((x) => x !== id);
  if (active === id) active = null;
}
async function closeTab(id) {
  const s = tabs.get(id);
  if (!s) return;
  const idx = order.indexOf(id);
  if (s.type === "chat") await api.closeTab(id);
  removeTabLocal(id);
  if (!order.length) return newTab();
  activate(order[Math.max(0, idx - 1)]);
}

// ── chat rendering ─────────────────────────────────────────────────────────
function atBottom(v) {
  return v.scrollHeight - v.scrollTop - v.clientHeight < 140;
}
function append(s, node) {
  const stick = atBottom(s.view);
  s.empty.hidden = true;
  s.view.appendChild(node);
  if (s.workingEl && node !== s.workingEl) s.view.appendChild(s.workingEl); // keep "working…" last
  s.logInner = null; // the next agent step starts a new log segment
  if (stick) s.view.scrollTop = s.view.scrollHeight;
  return node;
}
/** Agent work (handoffs, tools, verifier, advisor) is drawn as a log on one hairline. */
function logAppend(s, node) {
  if (!s.logInner) {
    const wrap = el("div", "log");
    s.logInner = el("div", "log-inner");
    wrap.appendChild(s.logInner);
    const stick = atBottom(s.view);
    s.empty.hidden = true;
    s.view.appendChild(wrap);
    if (s.workingEl) s.view.appendChild(s.workingEl); // keep "working…" last
    if (stick) s.view.scrollTop = s.view.scrollHeight;
  }
  const stick = atBottom(s.view);
  s.logInner.appendChild(node);
  if (stick) s.view.scrollTop = s.view.scrollHeight;
  return node;
}
const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function who(kind, label, extra, time) {
  const w = el("div", "who");
  w.append(el("span", `mk${kind === "ai" ? " ai" : kind === "gpt" ? " gpt" : ""}`), el("span", "", label));
  if (time) w.append(el("span", "", `· ${time}`));
  if (extra) w.append(el("span", "src", extra));
  return w;
}
function addUser(s, text, source, queued, change, live = true) {
  const m = el("div", `msg user${change ? " change" : ""}`);
  m.append(who("user", "You", change ? "correction, mid-task" : source === "terminal" ? "from the terminal" : source === "auto" ? "re-sent automatically" : queued ? "queued" : "", live ? clock() : ""));
  m.append(el("div", "bubble", text));
  append(s, m);
  s.view.scrollTop = s.view.scrollHeight;
}
function assistantShell(s) {
  const m = el("div", "msg assistant");
  const gpt = isGpt(s.info.model);
  m.append(who(gpt ? "gpt" : "ai", shortModel(s.info.model), "", s.loaded && !s.replaying ? clock() : ""));
  const b = el("div", "bubble");
  m.append(b);
  return { m, b };
}
function addAssistant(s, text) {
  const { m, b } = assistantShell(s);
  b.innerHTML = md(text);
  append(s, m);
}
// ── "working…" line: what the agent is doing right now, until the reply arrives ──
const short = (t, n = 72) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
function describeTool(name, summary) {
  const what = short(String(summary ?? "").trim());
  const file = what.split(/[\\/]/).pop();
  if (name === "Bash") return what ? `Running ${what}` : "Running a command";
  if (name === "Read") return `Reading ${file || "a file"}`;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return `Editing ${file || "a file"}`;
  if (name === "Grep" || name === "Glob") return what ? `Searching for ${what}` : "Searching the code";
  if (name === "WebSearch") return what ? `Searching the web: ${what}` : "Searching the web";
  if (name === "WebFetch") return what ? `Reading ${what}` : "Reading a web page";
  if (name === "TodoWrite") return "Planning the steps";
  if (name === "ToolSearch") return "Looking up tools";
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (m) return `Using ${m[1].replace(/^(plugin_|claude_ai_)/, "").replace(/_/g, " ")}: ${m[2].replace(/[_-]/g, " ")}`;
  return what ? `${name}: ${what}` : name;
}
function setWorking(s, text) {
  if (!s.workingEl) {
    const w = el("div", "working");
    w.append(el("span", "spin"), el("span", "w-what"), el("span", "w-time mono"));
    s.workingEl = w;
    s.workingSince = Date.now();
    append(s, w);
  }
  s.workingEl.querySelector(".w-what").textContent = text;
  s.workingEl.hidden = !!s.live; // the reply itself is streaming: it shows progress already
  tickWorking(s);
}
function tickWorking(s) {
  if (!s.workingEl) return;
  const sec = Math.floor((Date.now() - s.workingSince) / 1000);
  s.workingEl.querySelector(".w-time").textContent = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
function stopWorking(s) {
  s.workingEl?.remove();
  s.workingEl = null;
}
function startLive(s) {
  if (s.workingEl) s.workingEl.hidden = true;
  const { m, b } = assistantShell(s);
  b.classList.add("streaming");
  s.live = b;
  s.liveText = "";
  append(s, m);
}
function flushLive(s) {
  if (!s.live) return;
  const stick = atBottom(s.view);
  s.live.innerHTML = md(s.liveText);
  if (stick) s.view.scrollTop = s.view.scrollHeight;
}
function endLive(s, finalText) {
  if (!s.live) {
    if (finalText) addAssistant(s, finalText);
    return;
  }
  clearTimeout(s.timer);
  s.timer = null;
  s.liveText = finalText ?? s.liveText;
  flushLive(s);
  s.live.classList.remove("streaming");
  s.live = null;
  s.liveText = "";
}
function addAgent(s, id, agent, description) {
  endLive(s);
  const card = el("div", "agent-card");
  const head = el("div", "agent-head");
  const count = el("span", "agent-count", "");
  head.append(el("span", "agent-name", agent), el("span", "agent-model", modelFor(agent)), el("span", "agent-desc", description), count);
  const tools = el("div", "agent-tools");
  head.onclick = () => card.classList.toggle("open");
  card.append(head, tools);
  logAppend(s, card);
  const entry = { card, tools, count, n: 0, done: false };
  s.agents.set(id, entry);
  s.lastAgent = entry;
}
function finishAgents(s) {
  for (const c of s.agents.values()) {
    if (c.done) continue;
    c.done = true;
    c.card.classList.add("done");
  }
}
function addTool(s, name, summary, sub) {
  if (name === "AskUserQuestion") return; // shown as a question card
  const row = el("div", "tool-row");
  row.append(el("b", "", name), document.createTextNode(` ${summary}`));
  if (sub && s.lastAgent) {
    s.lastAgent.tools.appendChild(row);
    s.lastAgent.n++;
    s.lastAgent.count.textContent = `${s.lastAgent.n} step${s.lastAgent.n === 1 ? "" : "s"}`;
    return;
  }
  if (!sub) finishAgents(s);
  endLive(s);
  const w = el("div", "main-tool");
  w.appendChild(row);
  logAppend(s, w);
}
function addVerify(s, e) {
  endLive(s);
  s.view.querySelector(".verify.running")?.remove();
  if (e.status === "running") {
    finishAgents(s);
    const v = el("div", "verify running");
    v.append(el("span", "k", "Verifying"), el("span", "spin"), el("span", "", `${modelFor("verifier")} is checking the work${e.round > 1 ? ` (round ${e.round})` : ""}`));
    logAppend(s, v);
    return;
  }
  const v = el("div", `verify ${e.status === "pass" ? "ok" : "bad"}`);
  const k = el("span", "k", e.status === "pass" ? "Verified" : "Changes requested");
  v.append(k, el("span", "", e.status === "pass" ? `${modelFor("verifier")} checked it` : `${modelFor("verifier")} sent it back; fixing`));
  logAppend(s, v);
  if (e.status === "fail" && e.feedback) {
    const d = el("div", "verify-detail", e.feedback.slice(0, 3000));
    d.hidden = true;
    k.onclick = () => (d.hidden = !d.hidden);
    logAppend(s, d);
  }
}
function addAdvice(s, status) {
  if (status === "answered") {
    const last = [...s.view.querySelectorAll(".advice")].pop();
    if (last) {
      last.querySelector(".spin")?.remove();
      last.querySelector(".txt").textContent = `${shortModel(info.models.advisor)} weighed in`;
    }
    return;
  }
  endLive(s);
  const a = el("div", "advice");
  a.append(el("span", "k", "Advisor"), el("span", "spin"), el("span", "txt", `asking ${shortModel(info.models.advisor)}…`));
  logAppend(s, a);
}
function addNote(s, text, cls = "") {
  append(s, el("div", `note ${cls}`, text));
}
/** Context is getting full: one card per chat that turns into "continue in a new chat". */
function addHandoff(s, e) {
  if (e.status === "failed") {
    s.handoffCard?.remove();
    s.handoffCard = null;
    return addNote(s, `Couldn't write the hand-off summary: ${e.error}`, "error");
  }
  const pct = e.percent != null ? `${Math.round(e.percent)}%` : null;
  const card = el("div", "handoff");
  const top = el("div", "h-top");
  top.append(el("span", "label-mono", "Context"), el("span", "", e.auto && pct ? `This chat's context is ${pct} full.` : pct ? `Context is ${pct} full.` : "Hand-off summary"));
  card.appendChild(top);
  if (e.status === "writing") {
    const w = el("div", "h-body muted");
    w.append(el("span", "spin"), document.createTextNode(" Writing a hand-off summary (context.md) so a new chat can pick up from here…"));
    card.appendChild(w);
  } else {
    card.appendChild(el("div", "h-body", "A hand-off summary (context.md) is ready. Continue in a new chat and everything from this one goes with it, or keep going here."));
    const acts = el("div", "row-actions");
    const go = el("button", "btn primary sm", "Continue in a new chat");
    go.onclick = async () => {
      go.disabled = true;
      try {
        const t = await api.continueInNewChat(s.id, e.file);
        const ns = ensureChatTab(t);
        ns.loaded = true;
        activate(t.id);
        addNote(ns, `Continuing "${s.info.title}". Its hand-off summary (context.md) goes with your first message here.`);
        input.focus();
      } catch (err) {
        addNote(s, String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "error");
        go.disabled = false;
      }
    };
    const view = el("button", "btn sm", "View context.md");
    view.onclick = () => {
      const b = el("div", "bubble");
      b.innerHTML = md(e.text ?? "");
      const box = el("div");
      box.append(el("p", "muted mono", e.file ?? ""), b);
      modal("context.md", box);
    };
    acts.append(go, view);
    card.appendChild(acts);
  }
  if (s.handoffCard?.isConnected) s.handoffCard.replaceWith(card);
  else append(s, card);
  s.handoffCard = card;
}
function addQuestion(s, id, questions) {
  endLive(s);
  const card = el("div", "question");
  card.dataset.qid = id;
  const picks = new Map();
  const others = new Map();
  const top = el("div", "q-top");
  top.append(icon("q"), el("span", "", `${shortModel(s.info.model)} has a question`));
  card.appendChild(top);
  const body = el("div", "q-body");
  for (const q of questions) {
    const head = el("div", "q-text", q.question);
    if (q.header) head.prepend(el("span", "label accent", q.header), document.createTextNode(" "));
    body.appendChild(head);
    picks.set(q.question, new Set());
    const opts = [];
    for (const o of q.options) {
      const b = el("button", `opt${q.multiSelect ? " multi" : ""}`);
      const ol = el("span", "ol");
      ol.append(el("span", "", o.label));
      if (o.description) ol.append(el("small", "", o.description));
      b.appendChild(ol);
      b.onclick = () => {
        const set = picks.get(q.question);
        if (!q.multiSelect) {
          set.clear();
          opts.forEach((n) => n.classList.remove("picked"));
        }
        set.has(o.label) ? set.delete(o.label) : set.add(o.label);
        b.classList.toggle("picked", set.has(o.label));
        if (!q.multiSelect && questions.length === 1) submit();
      };
      opts.push(b);
      body.appendChild(b);
    }
    const other = el("div", "other");
    const inp = el("input", "input");
    inp.placeholder = "Other…";
    inp.onkeydown = (e) => e.key === "Enter" && submit();
    others.set(q.question, inp);
    other.appendChild(inp);
    body.appendChild(other);
  }
  body.appendChild(el("div", "q-answer"));
  const acts = el("div", "q-actions");
  const skip = el("button", "btn", "Skip");
  const send = el("button", "btn primary", "Answer");
  acts.append(skip, send);
  card.append(body, acts);
  function submit() {
    const answers = {};
    for (const q of questions) answers[q.question] = others.get(q.question).value.trim() || [...picks.get(q.question)].join(", ") || "(no answer)";
    api.answer(s.id, id, answers);
  }
  send.onclick = submit;
  skip.onclick = () => api.answer(s.id, id, Object.fromEntries(questions.map((q) => [q.question, "(skipped, use your judgment)"])));
  append(s, card);
  s.view.scrollTop = s.view.scrollHeight;
}
function markAnswered(s, id, answers) {
  const card = s.view.querySelector(`.question[data-qid="${id}"]`);
  if (!card) return;
  card.classList.add("done");
  card.querySelector(".q-answer").textContent = `Answered: ${Object.values(answers).join(" · ") || "skipped"}`;
}
function clearView(s) {
  s.live = null;
  s.lastAgent = null;
  s.logInner = null;
  s.agents.clear();
  s.context = null;
  [...s.view.children].forEach((n) => n !== s.empty && n.remove());
  s.empty.hidden = false;
}
function renderHistory(s, items) {
  clearView(s);
  s.replaying = true;
  for (const it of items) {
    if (it.role === "user") addUser(s, it.text, undefined, false, it.change, false);
    else if (it.role === "assistant") addAssistant(s, it.text);
    else if (it.role === "agent") {
      const [agent, ...rest] = it.text.split(": ");
      addAgent(s, `h${Math.random()}`, agent, rest.join(": "));
    } else {
      const m = it.text.match(/^([^(]+)\((.*)\)$/s);
      addTool(s, m ? m[1] : it.text, m ? m[2] : "", false);
    }
  }
  finishAgents(s);
  s.replaying = false;
  s.view.scrollTop = s.view.scrollHeight;
}

// ── events from the engine ─────────────────────────────────────────────────
api.onEvent(({ tabId, event: e }) => {
  const s = tabs.get(tabId);
  if (!s) return;
  switch (e.type) {
    case "user":
      addUser(s, e.text, e.source, e.queued, e.change);
      if (!e.queued && !e.change) setWorking(s, "Thinking");
      break;
    case "busy":
      if (e.busy && !s.workingEl) setWorking(s, "Thinking");
      if (!e.busy) {
        stopWorking(s);
        endLive(s);
        finishAgents(s);
        refreshChats();
        refreshDocs();
      }
      break;
    case "text-delta":
      if (!s.live) startLive(s);
      s.liveText += e.text;
      if (!s.timer)
        s.timer = setTimeout(() => {
          s.timer = null;
          flushLive(s);
        }, 60);
      break;
    case "text":
      endLive(s, e.text);
      if (s.workingEl) setWorking(s, "Thinking");
      break;
    case "agent":
      addAgent(s, e.id, e.agent, e.description);
      setWorking(s, `${e.agent} is working: ${short(e.description || "", 60)}`);
      break;
    case "tool":
      addTool(s, e.name, e.summary, e.sub);
      if (e.name !== "Agent" && e.name !== "Task" && e.name !== "AskUserQuestion") setWorking(s, e.sub && s.lastAgent ? `${describeTool(e.name, e.summary)}` : describeTool(e.name, e.summary));
      break;
    case "verify":
      addVerify(s, e);
      if (e.status === "running") setWorking(s, `Verifying the work${e.round > 1 ? ` (round ${e.round})` : ""}`);
      break;
    case "turn-end": {
      endLive(s);
      const bits = [`${e.numTurns} turn${e.numTurns === 1 ? "" : "s"}`];
      if (e.agents.length) bits.push(`agents: ${e.agents.join(", ")}`);
      if (info && !info.subscriptionOnly && e.costUsd) bits.push(`~$${e.costUsd.toFixed(2)} API`);
      append(s, el("div", "meta", bits.join(" · ")));
      if (e.isError) addNote(s, `The turn ended with an error: ${e.error}`, "error");
      break;
    }
    case "error":
      endLive(s);
      addNote(s, e.message, "error");
      break;
    case "note":
      addNote(s, e.text, /usage limit|^FAIL/.test(e.text) ? "error" : "");
      break;
    case "question":
      addQuestion(s, e.id, e.questions);
      if (s.workingEl) setWorking(s, "Waiting for your answer");
      break;
    case "question-answered":
      markAnswered(s, e.id, e.answers);
      if (s.workingEl) setWorking(s, "Thinking");
      break;
    case "advisor":
      addAdvice(s, e.status);
      if (e.status === "asked") setWorking(s, "Consulting the advisor");
      break;
    case "handoff":
      addHandoff(s, e);
      break;
    case "usage":
      refreshUsage();
      break;
    case "context":
      s.context = e.context;
      renderStatus();
      break;
  }
});
api.onTabs((list) => {
  const seen = new Set();
  for (const t of list) {
    ensureChatTab(t);
    seen.add(t.id);
  }
  for (const [id, s] of tabs) if (s.type === "chat" && !seen.has(id)) removeTabLocal(id);
  if (!active || !tabs.has(active)) active = order[order.length - 1];
  renderTabs();
  syncToolbar();
});
api.onFocusTab((id) => tabs.has(id) && activate(id));

// ── toolbar & status bar ───────────────────────────────────────────────────
function syncToolbar() {
  const s = cur();
  if (!s) return;
  const chat = s.type === "chat";
  $("toolbar").querySelector(".top-actions").hidden = !chat;
  $("composerWrap").hidden = !chat;
  $("chatTitle").textContent = chat ? s.info.title : s.title;
  if (chat) {
    $("verifyBtn").classList.toggle("on", s.info.verify);
    $("modelMark").classList.toggle("gpt", isGpt(s.info.model));
    $("verifyBtn").hidden = s.info.kind === "gpt";
    $("forkBtn").hidden = s.info.kind === "gpt";
    $("modelSelect").value = s.info.model;
    setBusyUi(s.info.busy);
  }
  renderStatus();
}
function setBusyUi(b) {
  $("sendBtn").textContent = b ? "Queue" : "Send";
  $("sendBtn").title = b ? "Run after the current turn (Enter)" : "Send (Enter)";
  $("changeBtn").hidden = !b;
  $("stopBtn").hidden = !b;
  $("composer").classList.toggle("running", b);
  $("hint").textContent = b
    ? "working · ⌘↵ corrects it now · ↵ queues for after"
    : "↵ send · ⇧↵ new line · / commands · @ apps";
}
function miniGrid(ctx) {
  const g = el("span", "mini-grid");
  g.style.gridTemplateColumns = "repeat(20, 5px)";
  // Squeeze the 100-square grid into 20 (each mini square = 5% of the window).
  const cells = (ctx?.grid ?? []).flat();
  const shown = Array.from({ length: 20 }, (_, i) => {
    const chunk = cells.slice(i * 5, i * 5 + 5);
    const used = chunk.filter((c) => c.fill);
    const ids = used.map((c) => c.id);
    const id = ids.sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length)[0] ?? "free_space";
    return { id, fill: chunk.length ? used.reduce((n, c) => n + c.fill, 0) / chunk.length : 0 };
  });
  for (const c of shown) {
    const i = el("i");
    if (c.fill) {
      const b = el("b");
      b.style.height = `${Math.round(c.fill * 100)}%`;
      b.style.top = "0";
      b.style.background = ctxColor(c.id);
      i.appendChild(b);
    }
    g.appendChild(i);
  }
  return g;
}
/** Number ticker (after Magic UI): values roll to their new number instead of jumping. */
const tickers = new Map();
function tickTo(node, key, value, format) {
  const from = tickers.get(key) ?? value;
  tickers.set(key, value);
  if (from === value) return (node.textContent = format(value));
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 600);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = format(Math.round(from + (value - from) * e));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderStatus() {
  const s = cur();
  const folder = (info?.workspace ?? "").split(/[\\/]/).pop();
  const proj = projectName();
  $("wsLabel").textContent = proj ? "Project" : "Workspace";
  $("wsName").textContent = proj ?? (folder || "…");
  $("sbFolder").title = `${info?.workspace ?? ""}\nClick to change the folder the agents work in`;
  const chat = s?.type === "chat";
  // context
  const sc = $("sbContext");
  sc.textContent = "";
  const ctx = chat ? s.context : null;
  const cv = el("span", "v");
  sc.append(el("span", "k", "Context"), miniGrid(ctx), cv);
  if (ctx) tickTo(cv, "ctx", ctx.percentage, (n) => `${n}%`);
  else cv.textContent = chat && s.info.kind === "gpt" ? "n/a" : "—";
  sc.title = ctx ? `${fmtTokens(ctx.total)} of ${fmtTokens(ctx.max)} tokens. Click for the breakdown.` : "Context window (/context)";
  // Claude plan usage
  const su = $("sbUsage");
  su.textContent = "";
  const w = usageState?.usage?.windows?.find((x) => x.key === "five_hour") ?? usageState?.usage?.windows?.[0];
  const uv = el("span", "v");
  const line = el("span", "meter-line");
  const fill = el("i");
  line.appendChild(fill);
  fill.style.width = "0%"; // empty until Claude reports usage; a full bar would read as "out"
  su.className = "inst";
  su.append(el("span", "k", "Claude"), line, uv);
  if (w && w.utilization != null) {
    const pct = Math.round(w.utilization * 100);
    fill.style.width = `${Math.min(100, pct)}%`;
    tickTo(uv, "usage", pct, (n) => `${n}%`);
    su.className = `inst${usageState.limited ? " bad" : pct >= 80 ? " warn" : ""}`;
    su.title = `${w.label}: ${pct}%${w.resetsAt ? `, resets ${fmtTime(w.resetsAt)}` : ""}. Click for details.`;
  } else uv.textContent = info?.subscriptionOnly === false ? "API" : "—";
  // ChatGPT plan usage (through Codex), or sign-in state when there's none yet
  const sg = $("sbGpt");
  sg.textContent = "";
  const gw = usageState?.gptUsage?.windows?.[0];
  if (gw && gw.utilization != null) {
    const pct = Math.round(gw.utilization * 100);
    const gline = el("span", "meter-line");
    const gfill = el("i");
    gfill.style.width = `${Math.min(100, pct)}%`;
    gline.appendChild(gfill);
    const gv = el("span", "v");
    sg.append(el("span", "k", "ChatGPT"), gline, gv);
    tickTo(gv, "gpt", pct, (n) => `${n}%`);
    sg.className = `inst${usageState.gptUsage.status === "rejected" ? " bad" : pct >= 80 ? " warn" : ""}`;
    sg.title = `${gw.label}: ${pct}%${gw.resetsAt ? `, resets ${fmtTime(gw.resetsAt)}` : ""}. Click for details.`;
  } else {
    const gv = el("span", "v", info?.codex?.ok ? "ready" : "connect");
    const dotWrap = el("span");
    dotWrap.append(el("span", `dot ${info?.codex?.ok ? "ok" : "warn"}`));
    sg.className = "inst";
    sg.append(el("span", "k", "ChatGPT"), dotWrap, gv);
    sg.title = info?.codex?.ok ? "Signed in. Usage shows once Codex reports it." : "Click to connect Codex to your ChatGPT plan (opens your browser)";
  }
}
function buildModelSelect() {
  const sel = $("modelSelect");
  sel.textContent = "";
  const claude = el("optgroup");
  claude.label = "Claude · your Claude plan";
  // Your list from /models; if empty, everything your plan offers; always the current main model.
  const names = new Map((info.availableModels ?? []).filter((m) => m.displayName).map((m) => [m.value, m.displayName]));
  const mine = info.models.claude?.length ? info.models.claude : [...names.keys()];
  const curModel = cur()?.info?.model;
  for (const m of [...new Set([info.models.main, ...mine, ...(curModel && !isGpt(curModel) ? [curModel] : [])])]) {
    const o = el("option", "", names.get(m) ?? shortModel(m));
    o.value = m;
    claude.appendChild(o);
  }
  const gpt = el("optgroup");
  gpt.label = "GPT · your ChatGPT plan";
  for (const m of info.models.gpt) {
    const o = el("option", "", shortModel(m));
    o.value = m;
    gpt.appendChild(o);
  }
  const more = el("optgroup");
  more.label = "Settings";
  const edit = el("option", "", "Edit models…");
  edit.value = "__edit_models";
  more.appendChild(edit);
  sel.append(claude, gpt, more);
  if (curModel) sel.value = curModel;
}

// ── /caffeinate: keep the computer awake ──────────────────────────────────
function describeAwake(st) {
  if (!st.on) return "Caffeinate is off: the computer can sleep as usual.";
  const what = st.display ? "the computer and screen" : "the computer";
  if (!st.until) return `Keeping ${what} awake until you run /caffeinate off (closing the lid still sleeps a Mac).`;
  return `Keeping ${what} awake until ${fmtTime(st.until)}.`;
}
function showAwake(st) {
  const chip = $("awakeChip");
  chip.hidden = !st.on;
  chip.textContent = st.on ? (st.until ? `awake · until ${fmtTime(st.until)}` : "awake") : "";
  document.body.classList.toggle("has-awake", !!st.on);
}
$("awakeChip").onclick = async () => showAwake(await api.caffeinate("off"));
api.onCaffeinate(showAwake);

// ── /remote: control this app from another app (e.g. Pally) over MCP ─────
async function showRemote() {
  const box = el("div");
  const render = async (st) => {
    st ??= await api.remoteStatus();
    box.textContent = "";
    box.appendChild(el("p", "muted", "Turn this on to control the app from another app that can add an MCP server, such as Pally: it can open tabs, send tasks, read replies, answer the agent's questions and stop work. GitHub push approvals still only happen here."));
    const row = el("div", "row-actions");
    const toggle = el("button", `btn ${st.enabled ? "danger" : "primary"}`, st.enabled ? "Turn off" : "Turn on");
    toggle.onclick = async () => render(st.enabled ? await api.remoteStop() : await api.remoteStart().catch((err) => ({ ...st, error: err.message })));
    row.appendChild(toggle);
    box.appendChild(row);
    if (st.error) box.appendChild(el("p", "error-text", st.error));
    if (!st.enabled) return;

    const link = (label, url, note) => {
      box.appendChild(el("h4", "", label));
      const r = el("div", "remote-link");
      const code = el("code", "", url);
      const copy = el("button", "btn sm", "Copy");
      copy.onclick = async () => {
        await navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      };
      r.append(code, copy);
      box.appendChild(r);
      if (note) box.appendChild(el("p", "muted", note));
    };
    link("On this computer", st.localUrl, "For apps running on this Mac.");

    box.appendChild(el("h4", "", "From the internet (Pally and other cloud apps)"));
    if (st.publicUrl) link("Public link", st.publicUrl, "Paste this into Pally as an MCP server. Anyone with this link can control the app, so keep it private. The address changes each time the tunnel starts.");
    else if (st.tunnel === "not-installed") box.appendChild(el("p", "muted", "Cloud apps can't reach this computer directly. Install Cloudflare's free tunnel tool (in Terminal: brew install cloudflared), then come back here to get a public link."));
    else box.appendChild(el("p", "muted", "Cloud apps can't reach this computer directly. Start a free Cloudflare tunnel to get a public link."));
    if (st.tunnelError) box.appendChild(el("p", "error-text", st.tunnelError));
    const tr = el("div", "row-actions");
    if (st.tunnel !== "not-installed") {
      const t = el("button", "btn", st.publicUrl ? "Stop public link" : st.tunnel === "starting" ? "Starting…" : "Get a public link");
      t.onclick = async () => {
        t.disabled = true;
        t.textContent = st.publicUrl ? "Stopping…" : "Starting…";
        render(await api.remoteTunnel(!st.publicUrl));
      };
      tr.appendChild(t);
    }
    const rot = el("button", "btn danger", "New secret link");
    rot.title = "Every old link stops working";
    rot.onclick = async () => render(await api.remoteRotate());
    tr.appendChild(rot);
    box.appendChild(tr);
  };
  modal("Remote control", box);
  await render();
}

// ── /models: pick the model for each role ─────────────────────────────────
const ROLE_LABELS = {
  main: ["Orchestrator", "Plans and delegates every task"],
  advisor: ["Advisor", "Second opinion when the work gets hard"],
  coder: ["Coder", "All coding work"],
  designer: ["Designer", "UI and visual design"],
  worker: ["Researcher", "Research, scraping, general tasks"],
  triage: ["Summarizer", "Condenses long pages and logs"],
  video: ["Video", "Video work"],
  verifier: ["Verifier", "Checks delegated work"],
  gui: ["UI tester (GPT)", "Runs browser tests through Codex"],
  image: ["Images (GPT)", "Image generation through Codex"],
  image_fallback: ["Images fallback", "Used if the image model is unavailable"],
};
async function showModels() {
  const data = await api.models();
  const box = el("div");
  const all = el("datalist");
  all.id = "modelOptions";
  for (const m of data.available) {
    const o = el("option");
    o.value = m.value;
    o.label = m.displayName || shortModel(m.value);
    all.appendChild(o);
  }
  for (const m of data.models.gpt ?? []) {
    const o = el("option");
    o.value = m;
    all.appendChild(o);
  }
  box.appendChild(all);
  box.appendChild(el("p", "muted", data.available.length ? `Pick from the ${data.available.length} Claude models your plan offers, or type any model id (GPT ids for the Codex roles).` : "Type any model id. Your plan's Claude models show here once you're signed in."));
  box.appendChild(el("h4", "", "Roles"));
  const inputs = {};
  const grid = el("div", "model-grid");
  for (const role of data.roles) {
    const [label, hint] = ROLE_LABELS[role] ?? [role, ""];
    const lab = el("label", "mg-label");
    lab.append(el("span", "", label), el("small", "", hint));
    const inp = el("input", "input mono");
    inp.setAttribute("list", "modelOptions");
    inp.value = data.models[role] ?? "";
    inputs[role] = inp;
    grid.append(lab, inp);
  }
  box.appendChild(grid);
  box.appendChild(el("h4", "", "Model picker"));
  const lists = el("div", "model-grid");
  const listRow = (key, label, hint) => {
    const lab = el("label", "mg-label");
    lab.append(el("span", "", label), el("small", "", hint));
    const inp = el("input", "input mono");
    inp.value = (data.models[key] ?? []).join(", ");
    inputs[key] = inp;
    lists.append(lab, inp);
  };
  listRow("claude", "Claude models", "Comma-separated. Empty: everything your plan offers");
  listRow("gpt", "GPT models", "Comma-separated, as Codex names them");
  listRow("fallback", "Fallback chain", "Tried in order if a model is overloaded");
  box.appendChild(lists);
  const msg = el("p", "muted");
  const acts = el("div", "row-actions");
  acts.style.marginTop = "14px";
  const save = el("button", "btn primary", "Save");
  save.onclick = async () => {
    const changes = {};
    for (const [k, inp] of Object.entries(inputs)) changes[k] = ["claude", "gpt", "fallback"].includes(k) ? inp.value.split(",").map((x) => x.trim()).filter(Boolean) : inp.value.trim();
    save.disabled = true;
    try {
      info.models = await api.saveModels(changes);
      buildModelSelect();
      refreshWelcomes();
      refreshAgents();
      msg.textContent = "Saved to harness.config.yaml. New messages use these models.";
    } catch (err) {
      msg.textContent = String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    }
    save.disabled = false;
  };
  acts.append(save);
  box.append(acts, msg);
  modal("Models", box);
}
$("modelSelect").onchange = async (e) => {
  const s = cur();
  const model = e.target.value;
  if (model === "__edit_models") {
    e.target.value = s?.info?.model ?? info.models.main;
    return showModels();
  }
  const r = await api.setModel(s.id, model);
  if (r.newTab) {
    const t = ensureChatTab({ id: r.tabId, kind: isGpt(model) ? "gpt" : "claude", model, title: "New chat", busy: false, verify: true, sessionId: null });
    t.loaded = true;
    activate(r.tabId);
    addNote(t, `${shortModel(model)} can't continue a ${isGpt(model) ? "Claude" : "GPT"} conversation, so it opened in a new tab.`);
  }
};
$("verifyBtn").onclick = () => cur()?.type === "chat" && api.setVerify(cur().id, !cur().info.verify);
$("sbVerify").onclick = () => $("verifyBtn").click();
$("sbModel").onclick = () => $("modelSelect").focus();
$("sbContext").onclick = () => showContext();
$("sbUsage").onclick = () => showUsage();
$("sbGpt").onclick = () => (info?.codex?.ok ? showUsage() : connectCodex());
/** Sign Codex in to ChatGPT from the app: opens the browser, then refreshes. */
async function connectCodex() {
  const sg = $("sbGpt");
  sg.querySelector(".v") && (sg.querySelector(".v").textContent = "opening browser…");
  const st = await api.codexLogin().catch((err) => ({ ok: false, detail: err.message }));
  info.codex = st;
  await refreshUsage(true);
  renderStatus();
  if (!st.ok) {
    const s = cur();
    if (s?.type === "chat") addNote(s, `ChatGPT isn't connected yet: ${st.detail}`, "error");
  }
}

// ── sidebar panes ──────────────────────────────────────────────────────────
const PANES = { projects: "Projects", chats: "Chats", docs: "Documents", memory: "Memory", connections: "MCP servers & apps", team: "Team" };
function setPane(p) {
  pane = p;
  document.querySelectorAll(".seg[data-pane]").forEach((b) => b.classList.toggle("active", b.dataset.pane === p));
  $("paneSearch").value = "";
  $("paneSearch").placeholder = p === "docs" ? "Search documents" : p === "chats" ? "Search chats (⌘K)" : p === "projects" ? "Find a project" : "Filter";
  renderPane();
  if (p === "docs") refreshDocs();
  if (p === "connections" && !connState.length) refreshConnections();
  if (p === "memory") refreshMemory();
  if (p === "projects") refreshProjects();
}
document.querySelectorAll(".seg[data-pane]").forEach((b) => (b.onclick = () => setPane(b.dataset.pane)));
$("newTaskBtn").onclick = () => newTab();
$("paneSearch").oninput = () => renderPane();
$("statusAct").onclick = () => showStatus();

function section(body, key, title, count, items) {
  const head = el("div", `section-title${collapsed.has(key) ? " collapsed" : ""}`);
  head.append(icon("chevD"), el("span", "", title));
  if (count !== undefined) head.append(el("span", "count", String(count)));
  head.onclick = () => {
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    renderPane();
  };
  body.appendChild(head);
  if (!collapsed.has(key)) items();
}
function paneActions(list) {
  const a = $("paneActions");
  a.textContent = "";
  for (const [ic, title, fn] of list) {
    const b = el("button", "icon-btn");
    b.title = title;
    b.appendChild(icon(ic));
    b.onclick = fn;
    a.appendChild(b);
  }
}
function renderPane() {
  const body = $("paneBody");
  body.textContent = "";
  const q = $("paneSearch").value.trim().toLowerCase();
  const match = (t) => !q || String(t).toLowerCase().includes(q);
  if (pane === "projects") {
    paneActions([["plus", "Add a project", () => editProject()], ["refresh", "Refresh", () => refreshProjects()]]);
    const { groups, current } = projectsState;
    if (!groups.length) {
      body.appendChild(el("div", "empty-pane", "No projects yet. Add one: it points at a folder and gets its own chats and memory."));
      return;
    }
    const hits = (p) => match(p.name) || match(p.path) || (p.children ?? []).some(hits);
    const row = (p, depth, groupName, parentPath) => {
      if (q && !hits(p)) return;
      const r = el("button", `row project-row${p.path === current ? " active" : ""}${p.exists ? "" : " missing"}`);
      r.style.paddingLeft = `${12 + depth * 14}px`;
      const st = el("span", "stack");
      st.append(el("span", "t", p.name), el("span", "sub", p.exists ? shortPath(p.path) : "folder not found"));
      r.append(icon("folder"), st);
      if (p.path === current) r.append(el("span", "rmeta", "open"));
      r.title = `${p.path}\nMemory: ${p.resolvedBank}\nRight-click to edit`;
      r.onclick = () => openProject(p);
      r.oncontextmenu = (e) => (e.preventDefault(), editProject({ project: p, group: groupName, parent: parentPath }));
      body.appendChild(r);
      for (const c of p.children ?? []) row(c, depth + 1, groupName, p.path);
    };
    const count = (list) => list.reduce((n, p) => n + 1 + count(p.children ?? []), 0);
    for (const g of groups) section(body, `projects:${g.name}`, g.name, count(g.projects), () => g.projects.forEach((p) => row(p, 0, g.name, null)));
    body.appendChild(el("div", "pane-note", "Each project has its own memory. Right-click one to rename, move or remove it."));
  } else if (pane === "chats") {
    paneActions([["plus", "New task (⌘T)", () => newTab()], ["refresh", "Refresh", () => refreshChats()]]);
    const open = new Set([...tabs.values()].filter((t) => t.type === "chat" && t.info.sessionId).map((t) => t.info.sessionId));
    const sid = cur()?.info?.sessionId;
    const groups = new Map();
    for (const c of allChats.filter((c) => match(c.title) || match(c.cwd ?? ""))) {
      const g = groupLabel(c.updated);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    if (!groups.size) body.appendChild(el("div", "empty-pane", q ? "No matching chats." : "No chats yet."));
    const cloud = el("button", "row cloud-row");
    cloud.append(icon("chat"), el("span", "t", "Cloud sessions"), el("span", "rmeta", "claude.ai ↗"));
    cloud.title = "Chats that run in the cloud (Claude Code on the web) open in your browser.";
    cloud.onclick = () => window.open("https://claude.ai/code");
    for (const [g, list] of groups)
      section(body, `chats:${g}`, g, list.length, () => {
        for (const c of list) {
          const r = el("button", `row${c.id === sid ? " active" : ""}`);
          const st = el("span", "stack");
          st.append(el("span", "t", c.title || "Untitled"), el("span", "sub", folderName(c.cwd)));
          r.append(icon("chat"), st);
          if (c.kind === "gpt") r.append(el("span", "label ok", "GPT"));
          if (open.has(c.id)) r.append(el("span", "rmeta", "open"));
          r.title = c.title;
          r.onclick = () => openChat(c);
          body.appendChild(r);
        }
      });
    body.appendChild(cloud);
  } else if (pane === "docs") {
    paneActions([["refresh", "Refresh", () => refreshDocs()]]);
    const list = docs.filter((d) => match(d.rel));
    const touched = list.filter((d) => d.touched);
    const prds = list.filter((d) => d.prd && !d.touched);
    const rest = list.filter((d) => !d.prd && !d.touched);
    const docRow = (d) => {
      const r = el("button", `row${cur()?.type === "doc" && cur().path === d.path ? " active" : ""}`);
      const st = el("span", "stack");
      st.append(el("span", "t", d.name), el("span", "sub", d.rel));
      r.append(icon("doc"), st);
      if (d.prd) r.append(el("span", "label accent", "PRD"));
      if (d.touched) r.append(el("span", "rmeta", d.touched));
      r.title = d.path;
      r.onclick = () => openDoc(d.path);
      body.appendChild(r);
    };
    if (!list.length) body.appendChild(el("div", "empty-pane", q ? "No matching documents." : "No documents (.md, .txt, .pdf, .docx) in this folder."));
    if (touched.length) section(body, "docs:touched", "Opened by agents", touched.length, () => touched.forEach(docRow));
    if (prds.length) section(body, "docs:prd", "PRDs", prds.length, () => prds.forEach(docRow));
    if (rest.length) section(body, "docs:all", "Documents", rest.length, () => rest.forEach(docRow));
  } else if (pane === "memory") {
    paneActions([["refresh", "Check again", () => refreshMemory()]]);
    for (const [key, name, sub] of [["claudeMem", "claude-mem", "Session memory"], ["hindsight", "Hindsight", "Long-term memory"]]) {
      const st = memStatus?.[key];
      const r = el("button", `row${cur()?.type === "memory" && cur().mem === key ? " active" : ""}`);
      const stack = el("span", "stack");
      const where = key === "hindsight" && st?.bank ? `${projectName() ?? folderName(info?.workspace)} · ${st.bank}` : st?.url;
      stack.append(el("span", "t", name), el("span", "sub", st?.up ? where : `${sub} · not running`));
      r.append(el("span", `dot ${st?.up ? "ok" : ""}`), stack);
      r.onclick = () => openMemory(key);
      body.appendChild(r);
    }
  } else if (pane === "connections") {
    paneActions([["refresh", "Check again", () => refreshConnections()], ["plus", "Add a server", () => showConnections(true)]]);
    const apps = accountRows();
    section(body, "conn:apps", "Accounts & apps", apps.length, () => {
      for (const a of apps) {
        const r = el("div", "row");
        const st = el("span", "stack");
        st.append(el("span", "t", a.name), el("span", "sub", a.sub));
        r.append(el("span", `dot ${a.ok ? "ok" : "bad"}`), st);
        body.appendChild(r);
      }
    });
    const list = connState.filter((c) => match(c.name));
    section(body, "conn:mcp", "MCP servers", list.length, () => {
      if (!connState.length) body.appendChild(el("div", "empty-pane", "Checking servers…"));
      for (const c of list) {
        const r = el("button", "row");
        const st = el("span", "stack");
        st.append(el("span", "t", c.name), el("span", "sub", c.status === "connected" ? `${c.tools} tools · ${c.source}` : c.status === "needs-auth" ? "needs sign-in" : c.status === "disabled" ? "off" : c.error || c.status));
        r.append(el("span", `dot ${c.status}`), st);
        r.title = c.error || c.target || c.name;
        r.onclick = () => showConnections();
        body.appendChild(r);
      }
    });
    const foot = el("div", "pane-foot");
    const b = el("button", "btn sm", "Manage servers…");
    b.onclick = () => showConnections();
    foot.appendChild(b);
    body.appendChild(foot);
  } else if (pane === "team") {
    paneActions([["plus", "New subagent", () => showSubagents()]]);
    const mine = agents.filter((a) => a.custom && match(a.name));
    const builtin = agents.filter((a) => !a.custom && match(a.name));
    const agentRow = (a) => {
      const r = el("button", "row");
      const st = el("span", "stack");
      st.append(el("span", "t", a.name), el("span", "sub", a.runsOn ? shortModel(a.runsOn.split(" ")[0]) : shortModel(a.model)));
      r.append(icon("people"), st);
      r.title = a.description;
      r.onclick = () => showAgents();
      body.appendChild(r);
    };
    section(body, "team:mine", "Your subagents", mine.length, () => (mine.length ? mine.forEach(agentRow) : body.appendChild(el("div", "empty-pane", "None yet. Use + or /subagents."))));
    section(body, "team:builtin", "Built-in", builtin.length, () => builtin.forEach(agentRow));
    const foot = el("div", "pane-foot");
    const b = el("button", "btn sm", "Create subagents…");
    b.onclick = () => showSubagents();
    foot.appendChild(b);
    body.appendChild(foot);
  }
}

// ── data refreshers ────────────────────────────────────────────────────────
async function refreshChats() {
  allChats = await api.chats();
  if (pane === "chats") renderPane();
}
async function refreshProjects() {
  projectsState = await api.projects();
  renderStatus();
  if (pane === "projects") renderPane();
}
async function refreshDocs() {
  docs = await api.docs();
  if (pane === "docs") renderPane();
}
async function refreshMemory() {
  memStatus = await api.memoryStatus();
  if (pane === "memory" || pane === "connections") renderPane();
}
async function refreshConnections(reconnect) {
  connState = await api.connections(reconnect);
  const bad = connState.filter((c) => ["failed", "needs-auth"].includes(c.status)).length;
  $("connBadge").hidden = !bad;
  $("connBadge").textContent = bad > 99 ? "99+" : String(bad);
  if (pane === "connections") renderPane();
  return connState;
}
async function refreshUsage(force) {
  usageState = await api.usage(force);
  renderStatus();
}
async function refreshAgents() {
  agents = await api.agents();
  if (pane === "team") renderPane();
}

// ── chats ──────────────────────────────────────────────────────────────────
async function openChat(c) {
  for (const [id, t] of tabs) if (t.type === "chat" && t.info.sessionId === c.id) return activate(id);
  const s = cur();
  if (s && s.type === "chat" && !s.info.sessionId && !s.info.busy) {
    try {
      const history = await api.openChat(s.id, c.id, c.title, c.cwd);
      s.loaded = true;
      renderHistory(s, history);
      s.context = null;
      api.context(s.id).then((x) => x && ((s.context = x), renderStatus()));
      renderPane();
    } catch (err) {
      addNote(s, err.message, "error");
    }
    return;
  }
  const t = await newTab({ chatId: c.id, title: c.title, cwd: c.cwd });
  t.loaded = true;
  renderHistory(t, await api.tabHistory(t.id));
}
async function newChatInTab() {
  const s = cur();
  if (!s || s.type !== "chat" || s.info.busy) return newTab();
  await api.newChat(s.id);
  clearView(s);
  input.focus();
}

// ── documents ──────────────────────────────────────────────────────────────
function renderSummary(box, sum, prd) {
  box.textContent = "";
  const top = el("div", "s-top");
  top.append(el("span", "label-mono", prd ? "PRD in brief" : "In brief"), el("span", "meta-r label-mono", `${shortModel(sum.model)} · ${fmtTime(sum.at)}`));
  const b = el("div", "s-body");
  b.append(el("p", "tldr", sum.tldr));
  const list = (title, items) => {
    if (!items?.length) return;
    b.append(el("h4", "label-mono", title));
    const ol = el("ol");
    for (const it of items) ol.append(el("li", "", it));
    b.append(ol);
  };
  list("Main points", sum.points);
  list(prd ? "Requirements" : "Must-haves & constraints", sum.requirements);
  list("Open questions", sum.open_questions);
  box.append(top, b);
  box.hidden = false;
}
async function openDoc(path) {
  for (const [id, t] of tabs) if (t.type === "doc" && t.path === path) return activate(id);
  let d;
  try {
    d = await api.readDoc(path);
  } catch (err) {
    const s = cur();
    if (s?.type === "chat") addNote(s, err.message, "error");
    return;
  }
  const name = path.split(/[\\/]/).pop();
  const s = addLocalTab("doc", name, { path: d.path });
  const wrap = el("div", "doc-wrap");
  const head = el("div", "doc-head");
  head.append(el("span", "path", d.path));
  if (d.prd) head.append(el("span", "label accent", "PRD"));
  const sumBtn = el("button", "btn primary sm", d.prd ? "Summarize PRD" : "Summarize");
  const askBtn = el("button", "btn sm", "Ask about it");
  const extBtn = el("button", "btn sm", "Open externally");
  head.append(sumBtn, askBtn, extBtn);
  const scroll = el("div", "doc-scroll");
  const inner = el("div", "doc-inner");
  const sumBox = el("div", "summary");
  sumBox.hidden = true;
  inner.appendChild(sumBox);
  if (d.text == null) inner.appendChild(el("p", "doc-binary", `${d.ext.slice(1).toUpperCase()} file (${fmtTokens(d.size)}B). It can't be shown here, but Summarize can read it.`));
  else if ([".md", ".mdx", ".markdown"].includes(d.ext)) {
    const b = el("div", "bubble");
    b.innerHTML = md(d.text);
    inner.appendChild(b);
  } else inner.appendChild(el("div", "doc-text", d.text));
  scroll.appendChild(inner);
  wrap.append(head, scroll);
  s.view.appendChild(wrap);
  if (d.summary) {
    renderSummary(sumBox, d.summary, d.prd);
    sumBtn.textContent = "Summarize again";
  }
  sumBtn.onclick = async () => {
    sumBtn.disabled = true;
    const old = sumBtn.textContent;
    sumBtn.textContent = "Summarizing…";
    sumBox.hidden = false;
    sumBox.textContent = "";
    const loading = el("div", "s-top");
    loading.append(el("span", "spin"), el("span", "", `${shortModel(info.models.triage)} is reading ${name}…`));
    sumBox.appendChild(loading);
    try {
      renderSummary(sumBox, await api.summarizeDoc(d.path, !!d.summary || old.includes("again")), d.prd);
      sumBtn.textContent = "Summarize again";
    } catch (err) {
      sumBox.textContent = err.message;
      sumBtn.textContent = old;
    } finally {
      sumBtn.disabled = false;
    }
  };
  askBtn.onclick = async () => {
    const t = await newTab();
    input.value = `Read ${d.path} and `;
    autoSize();
    input.focus();
    return t;
  };
  extBtn.onclick = () => api.openDocExternal(d.path);
  activate(s.id);
  renderPane();
}

// ── memory viewers ─────────────────────────────────────────────────────────
const MEM = {
  claudeMem: {
    title: "claude-mem",
    start: ["Session memory for Claude Code. Start its worker here; if it was never set up, run npx claude-mem install once in a terminal first.", "The app looks for its viewer on the port in ~/.claude-mem/settings.json, then the ones under memory.claude_mem in harness.config.yaml."],
    button: "Start claude-mem",
  },
  hindsight: {
    title: "Hindsight",
    start: ["Long-term memory. Each project has its own memory bank. On a Mac where Hindsight is installed, Start runs its own background services; otherwise it runs in Docker from docker-compose.yml (Docker has to be open, and the first start downloads it).", "Its web UI address is set under memory.hindsight in harness.config.yaml."],
    button: "Start Hindsight",
  },
};
async function openMemory(key) {
  await refreshMemory();
  const st = memStatus[key];
  // Hindsight opens on the current project's bank; a tab showing another project's bank is replaced.
  for (const [id, t] of tabs) {
    if (t.type !== "memory" || t.mem !== key) continue;
    if (key !== "hindsight" || t.bank === st.bank) return activate(id);
    await closeTab(id);
  }
  const s = addLocalTab("memory", key === "hindsight" && st.bank ? `Hindsight · ${projectName() ?? folderName(info?.workspace)}` : MEM[key].title, { mem: key, bank: st.bank });
  if (st.up) {
    st.url = st.bankUrl ?? st.url;
    const wrap = el("div", "doc-wrap");
    const head = el("div", "doc-head");
    const reload = el("button", "btn sm", "Reload");
    const ext = el("button", "btn sm", "Open in browser");
    head.append(el("span", "path", st.url), reload, ext);
    const frame = el("iframe", "mem-frame");
    frame.src = st.url;
    reload.onclick = () => (frame.src = st.url);
    ext.onclick = () => window.open(st.url, "_blank");
    wrap.append(head, frame);
    s.view.appendChild(wrap);
  } else {
    const off = el("div", "mem-off");
    off.append(el("h2", "", `${MEM[key].title} isn't running`));
    for (const line of MEM[key].start) off.appendChild(el("p", "", line));
    const acts = el("div", "row-actions");
    const status = el("p", "muted");
    const out = el("pre", "mem-out");
    out.hidden = true;
    const reopen = async () => {
      await closeTab(s.id);
      await refreshMemory();
      openMemory(key);
    };
    const show = (r) => {
      status.textContent = r.detail;
      status.className = r.ok && r.up !== false ? "muted" : "error-text";
      out.textContent = r.output ?? "";
      out.hidden = !r.output || (r.ok && r.up);
    };
    const start = el("button", "btn primary", MEM[key].button);
    start.onclick = async () => {
      start.disabled = true;
      status.className = "muted";
      status.textContent = "";
      status.append(el("span", "spin"), document.createTextNode(key === "hindsight" ? " Starting Hindsight…" : " Starting claude-mem…"));
      const r = await api.memoryStart(key).catch((err) => ({ ok: false, detail: err.message }));
      start.disabled = false;
      if (r.up) return reopen();
      show(r);
    };
    acts.appendChild(start);
    if (key === "claudeMem") {
      const doc = el("button", "btn", "Diagnose");
      doc.onclick = async () => {
        doc.disabled = true;
        status.textContent = "";
        status.append(el("span", "spin"), document.createTextNode(" Running npx claude-mem doctor…"));
        show(await api.memoryDoctor().catch((err) => ({ ok: false, detail: err.message })));
        out.hidden = !out.textContent;
        doc.disabled = false;
      };
      acts.appendChild(doc);
    }
    const retry = el("button", "btn", "Check again");
    retry.onclick = reopen;
    acts.appendChild(retry);
    off.append(acts, status, out);
    s.view.appendChild(off);
  }
  activate(s.id);
}

// ── dialogs ────────────────────────────────────────────────────────────────
function modal(title, body) {
  $("modalTitle").textContent = title;
  const b = $("modalBody");
  b.textContent = "";
  b.appendChild(body);
  $("modal").hidden = false;
}
$("modalClose").onclick = () => ($("modal").hidden = true);
$("modal").onclick = (e) => e.target.id === "modal" && ($("modal").hidden = true);

const CTX_COLORS = {
  system_prompt: "--ctx-system",
  system_tools: "--ctx-tools",
  mcp_tools: "--ctx-mcp",
  mcp_instructions: "--ctx-mcp",
  custom_agents: "--ctx-agents",
  memory_files: "--ctx-memory",
  skills: "--ctx-skills",
  messages: "--ctx-messages",
  autocompact_buffer: "--ctx-buffer",
  compact_buffer: "--ctx-buffer",
};
const ctxColor = (id) => (CTX_COLORS[id] ? `var(${CTX_COLORS[id]})` : "transparent");

/** /context: the same square grid Claude Code shows, by category. */
async function showContext() {
  const s = cur();
  if (s?.type !== "chat") return;
  let ctx = s.context;
  if (!ctx && s.info.sessionId) ctx = s.context = await api.context(s.id);
  const box = el("div");
  if (!ctx) {
    box.appendChild(el("p", "muted", s.info.kind === "gpt" ? "Context details aren't available for GPT chats." : "Send a message first; the grid fills in after the first reply."));
    return modal("Context", box);
  }
  const wrap = el("div", "ctx");
  const grid = el("div", "ctx-grid");
  // Same squares and order as Claude Code; laid out 20 across when the window is large.
  const cells = ctx.grid.flat();
  const cols = cells.length > 100 ? 20 : 10;
  const size = cols > 10 ? 15 : 18;
  grid.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
  grid.style.gridAutoRows = `${size}px`;
  for (const c of cells) {
      const i = el("i");
      if (c.fill) {
        const b = el("b");
        b.style.height = `${Math.max(15, Math.round(c.fill * 100))}%`;
        b.style.top = "0";
        b.style.background = ctxColor(c.id);
        i.appendChild(b);
      }
      i.title = c.id.replace(/_/g, " ");
      grid.appendChild(i);
    }
  const right = el("div");
  const total = el("div", "ctx-total");
  total.append(el("strong", "", `${ctx.percentage}% used`), document.createTextNode(`${fmtTokens(ctx.total)} of ${fmtTokens(ctx.max)} tokens on ${shortModel(ctx.model)}`));
  const legend = el("div", "ctx-legend");
  for (const c of ctx.categories.filter((c) => c.kind !== "deferred")) {
    const lg = el("div", "lg");
    const sw = el("span", "sw");
    sw.style.background = c.kind === "free" ? "transparent" : ctxColor(c.id);
    if (c.kind === "free") sw.style.border = "1px solid var(--border)";
    lg.append(sw, el("span", "", c.name), el("span", "num", `${fmtTokens(c.tokens)} · ${((c.tokens / ctx.max) * 100).toFixed(1)}%`));
    legend.appendChild(lg);
  }
  const deferred = ctx.categories.filter((c) => c.kind === "deferred");
  right.append(total, legend);
  if (deferred.length) right.append(el("p", "muted", `Not loaded until needed: ${deferred.map((c) => `${c.name} ${fmtTokens(c.tokens)}`).join(", ")}.`));
  wrap.append(grid, right);
  box.appendChild(wrap);
  modal("Context window", box);
}

async function showUsage() {
  await refreshUsage(true);
  const u = usageState;
  const box = el("div");
  box.appendChild(el("h4", "", "Claude plan"));
  if (!u.usage?.windows?.length) box.appendChild(el("p", "muted", "No usage from your Claude plan yet. It shows once Claude reports it (at start, or after your first message)."));
  const meters = (windows) => {
    for (const w of windows ?? []) {
      const pct = w.utilization == null ? null : Math.round(w.utilization * 100);
      const m = el("div", `meter${pct >= 100 || w.status === "rejected" ? " full" : pct >= 80 ? " warn" : ""}`);
      m.append(el("span", "", w.label), el("span", "", pct == null ? "?" : `${pct}%`));
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = `${Math.min(100, pct ?? 0)}%`;
      bar.appendChild(fill);
      m.appendChild(bar);
      if (w.resetsAt) m.appendChild(el("span", "when", `Resets ${fmtTime(w.resetsAt)}`));
      box.appendChild(m);
    }
  };
  meters(u.usage?.windows);
  box.appendChild(el("h4", "", `ChatGPT plan${u.gptUsage?.plan ? ` · ${u.gptUsage.plan}` : ""}`));
  if (u.gptUsage?.windows?.length) meters(u.gptUsage.windows);
  else box.appendChild(el("p", "muted", u.codex.ok ? `Signed in · ${info.models.gpt.map(shortModel).join(", ")}. Codex hasn't reported usage yet.` : u.codex.detail));
  const c = el("div", `callout${u.limited ? " bad" : ""}`);
  c.textContent = u.limited
    ? `Claude is at its limit until ${fmtTime(u.usage?.resetsAt)}. Tasks continue on ${shortModel(u.gpt)}.`
    : `If Claude runs out, the task that hit the limit continues on ${shortModel(u.gpt)} with your ChatGPT plan, and new tabs start there until Claude resets.`;
  box.appendChild(c);
  modal("Usage", box);
}

function accountRows() {
  return [
    { name: "Claude plan", ok: !!info?.auth.plan || info?.subscriptionOnly === false, sub: info?.auth.plan ? `Signed in · ${info.auth.plan}` : info?.subscriptionOnly === false ? "API billing allowed" : "Not signed in" },
    { name: "ChatGPT plan", ok: !!info?.codex.ok, sub: info?.codex.detail ?? "", connect: !info?.codex.ok ? connectCodex : null },
    { name: "claude-mem", ok: !!memStatus?.claudeMem.up, sub: memStatus?.claudeMem.up ? memStatus.claudeMem.url : "Not running" },
    { name: "Hindsight", ok: !!memStatus?.hindsight.up, sub: memStatus?.hindsight.up ? memStatus.hindsight.url : "Not running" },
  ];
}
async function showConnections(focusAdd = false) {
  const box = el("div");
  const render = async (reconnect) => {
    box.textContent = "";
    box.appendChild(el("p", "muted", reconnect ? `Reconnecting ${reconnect}…` : "Checking servers…"));
    const list = await refreshConnections(reconnect);
    box.textContent = "";
    box.appendChild(el("h4", "", "Accounts & apps"));
    for (const a of accountRows()) {
      const r = el("div", "list-row");
      r.append(el("span", `dot ${a.ok ? "ok" : "bad"}`), el("div", "name", a.name), el("div", "sub", a.sub));
      if (a.connect) {
        const acts = el("div", "acts");
        const b = el("button", "btn sm primary", "Connect");
        b.onclick = async () => {
          b.disabled = true;
          b.textContent = "Finish in your browser…";
          await a.connect();
          render();
        };
        acts.appendChild(b);
        r.appendChild(acts);
      }
      box.appendChild(r);
    }
    box.appendChild(el("h4", "", `MCP servers (${list.length})`));
    for (const c of list) {
      const r = el("div", "list-row");
      const name = el("div", "name", c.name);
      name.appendChild(el("span", "label", c.source));
      const detail = c.status === "connected" ? `${c.tools} tool${c.tools === 1 ? "" : "s"}${c.target ? ` · ${c.target}` : ""}` : c.status === "needs-auth" ? "Needs sign-in. Click Sign in, pick the server in the list, then come back and Refresh" : c.status === "disabled" ? "Turned off" : c.error || c.target || c.status;
      const sub = el("div", "sub", detail);
      sub.title = detail;
      const acts = el("div", "acts");
      if (c.signIn) {
        const si = el("button", "btn sm primary", "Sign in");
        si.onclick = async () => {
          try {
            await api.mcpSignIn();
            si.textContent = "Opened in terminal";
          } catch (err) {
            si.textContent = "Couldn't open";
            si.title = err.message;
          }
        };
        acts.appendChild(si);
      }
      if (["failed", "needs-auth", "pending"].includes(c.status)) {
        const rc = el("button", "btn sm", "Reconnect");
        rc.onclick = () => render(c.name);
        acts.appendChild(rc);
      }
      const tg = el("button", "btn sm", c.enabled ? "Turn off" : "Turn on");
      tg.onclick = async () => (await api.mcpToggle(c.name, !c.enabled), render());
      acts.appendChild(tg);
      if (c.removable) {
        const rm = el("button", "btn sm danger", "Remove");
        rm.onclick = async () => (await api.mcpRemove(c.name), render());
        acts.appendChild(rm);
      }
      r.append(el("span", `dot ${c.status}`), name, sub, acts);
      box.appendChild(r);
    }
    box.appendChild(el("h4", "", "Add an MCP server"));
    const form = el("div", "form-grid");
    const nm = el("input", "input");
    nm.placeholder = "Name, e.g. notion";
    const spec = el("input", "input");
    spec.placeholder = "URL (https://…) or command (npx -y some-mcp-server)";
    const add = el("button", "btn primary", "Add");
    const msg = el("p", "muted");
    add.onclick = async () => {
      if (!nm.value.trim() || !spec.value.trim()) return (msg.textContent = "Give it a name and a URL or command.");
      add.disabled = true;
      msg.textContent = "Adding…";
      try {
        const r = await api.mcpAdd(nm.value, spec.value);
        render();
        if (r?.note) setTimeout(() => box.appendChild(el("p", "muted", r.note)), 0);
      } catch (err) {
        msg.textContent = String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        add.disabled = false;
      }
    };
    form.append(nm, spec, add);
    box.appendChild(form);
    box.appendChild(msg);
    box.appendChild(el("p", "muted", "A URL (like https://agent.pally.com/mcp) is added to Claude Code's server list, so you can sign in to it. A command is saved in mcp-servers.json. Either way every tab can use it from the next message."));
    if (focusAdd) nm.focus();
  };
  modal("MCP servers & apps", box);
  render();
}

async function showDesign(q) {
  const links = await api.design(q);
  const box = el("div");
  if (!links.length) box.appendChild(el("p", "muted", "No matches."));
  for (const l of links) {
    const a = el("a", "link-row");
    a.href = l.url;
    a.target = "_blank";
    a.append(el("strong", "", l.title), el("small", "", `${l.notes ? l.notes + " · " : ""}${l.section ?? ""}`));
    box.appendChild(a);
  }
  const open = el("button", "btn sm", "Edit UI-LINKS.md");
  open.style.marginTop = "10px";
  open.onclick = () => api.openDesignLibrary();
  box.appendChild(open);
  modal(q ? `UI links: ${q}` : "UI links", box);
}

function agentRowEl(a, onRemove) {
  const r = el("div", "agent-row");
  const name = el("div", "an", a.name);
  name.append(el("span", "am", a.runsOn ? shortModel(a.runsOn.split(" ")[0]) : shortModel(a.model || "")));
  const p = el("p", "", a.description);
  if (a.custom) p.prepend(el("span", "label accent", "yours"), document.createTextNode(" "));
  r.append(name, p);
  if (onRemove) {
    const x = el("button", "btn sm danger", "Remove");
    x.onclick = () => onRemove(a.name);
    r.appendChild(x);
  } else r.appendChild(el("span"));
  return r;
}
async function showAgents() {
  await refreshAgents();
  const box = el("div");
  for (const a of agents) box.appendChild(agentRowEl(a));
  modal("The team", box);
}
async function showSubagents(prefill = "", autoRun = false) {
  const box = el("div");
  const form = el("div", "sub-form");
  const ta = el("textarea");
  ta.placeholder = 'Describe the subagents you want, e.g. "an SEO writer on Sonnet and a GPT-6 Astra copy critic". Leave empty and the Fable advisor will suggest some for this project.';
  ta.value = prefill;
  const go = el("button", "btn primary", "Design with the advisor");
  const status = el("span", "muted", "");
  const file = el("button", "btn", "Edit subagents.yaml");
  file.onclick = () => api.openSubagentsFile();
  const row = el("div", "row-actions");
  row.append(go, file, status);
  const results = el("div");
  form.append(ta, row, results);
  const team = el("div");
  const renderTeam = async () => {
    await refreshAgents();
    team.textContent = "";
    for (const a of agents) team.appendChild(agentRowEl(a, a.custom ? async (n) => (await api.removeSubagent(n), renderTeam()) : null));
  };
  go.onclick = async () => {
    go.disabled = true;
    results.textContent = "";
    status.textContent = "";
    status.prepend(el("span", "spin"));
    status.append(document.createTextNode(ta.value.trim() ? " The advisor is designing your subagents…" : " The advisor is looking at your project…"));
    try {
      const { summary, subagents } = await api.designSubagents(ta.value);
      status.textContent = "";
      if (summary) results.appendChild(el("p", "muted", summary));
      const picks = [];
      for (const a of subagents) {
        const card = el("div", "proposal");
        const label = el("label");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = true;
        picks.push([cb, a]);
        label.append(cb, el("span", "", a.name), el("span", "label", shortModel(a.model)));
        const det = el("details");
        det.append(el("summary", "", "System prompt"), Object.assign(el("pre"), { textContent: a.prompt }));
        card.append(label, el("p", "", a.description), det);
        results.appendChild(card);
      }
      const save = el("button", "btn primary", "Add selected to the team");
      save.style.marginTop = "10px";
      save.onclick = async () => {
        const chosen = picks.filter(([cb]) => cb.checked).map(([, a]) => a);
        if (!chosen.length) return;
        await api.saveSubagents(chosen);
        results.textContent = "";
        results.appendChild(el("p", "muted", `Added ${chosen.map((a) => a.name).join(", ")}. The orchestrator can use them from your next message.`));
        renderTeam();
      };
      results.appendChild(save);
      results.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      status.textContent = err.message;
    } finally {
      go.disabled = false;
    }
  };
  box.append(form, el("h4", "", "Current team"), team);
  modal("Subagents", box);
  renderTeam();
  if (autoRun) go.click();
}

function showStatus() {
  const dl = el("dl", "kv");
  const row = (k, v) => dl.append(el("dt", "", k), el("dd", "", v));
  row("Billing", info.subscriptionOnly ? "Subscriptions only" : "API keys allowed (HARNESS_ALLOW_API=1)");
  row("Claude plan", info.auth.plan || info.auth.error || "unknown");
  row("ChatGPT (Codex)", info.codex.detail);
  for (const [k, v] of Object.entries(info.models)) row(k, Array.isArray(v) ? v.join(", ") : v);
  row("Folder", info.workspace);
  const mb = el("button", "btn sm", "Edit models");
  mb.onclick = () => showModels();
  dl.append(el("dt", "", ""), Object.assign(el("dd"), {}));
  dl.lastChild.appendChild(mb);
  row("Plugins", info.plugins.join(", ") || "none (run npm run setup)");
  row("UI links", `${info.designCount} links`);
  row("Terminal link", "Run npm start while this app is open to share its tabs");
  const box = el("div");
  box.appendChild(dl);
  const r = el("div", "row-actions");
  r.style.marginTop = "12px";
  const cfg = el("button", "btn", "Open harness.config.yaml");
  cfg.onclick = () => api.openConfig();
  const help = el("button", "btn", "All commands");
  help.onclick = () => showHelp();
  r.append(cfg, help);
  box.appendChild(r);
  modal("Status", box);
}
function showHelp() {
  const box = el("div");
  let group = "";
  for (const c of COMMANDS) {
    if (c.group !== group) {
      group = c.group;
      box.appendChild(el("h4", "", group));
    }
    const r = el("div", "slash-item");
    r.append(el("code", "", c.name + (c.args ? ` ${c.args}` : "")), el("span", "", c.description));
    box.appendChild(r);
  }
  box.appendChild(el("p", "muted", "⌘T new tab · ⌘W close · ⌘1–9 switch · ⌘K search chats · ⌘N new chat · ⌘Enter change the running task"));
  modal("Commands", box);
}

// ── btw ────────────────────────────────────────────────────────────────────
function openBtw() {
  $("btwPanel").hidden = false;
  $("btwInput").focus();
}
async function btw(q) {
  const s = cur();
  if (s?.type !== "chat") return;
  openBtw();
  const item = el("div");
  const a = el("div", "btw-a loading", "Thinking…");
  item.append(el("div", "btw-q", q), a);
  $("btwList").appendChild(item);
  try {
    a.innerHTML = md(await api.btw(s.id, q));
    a.classList.remove("loading");
  } catch (err) {
    a.textContent = err.message;
  }
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

// ── fork, rename, folder ───────────────────────────────────────────────────
async function fork(title) {
  const s = cur();
  try {
    await api.fork(s.id, title);
    addNote(s, "Forked. The copy opened in a new window.");
  } catch (err) {
    addNote(s, err.message);
  }
}
$("forkBtn").onclick = () => fork();
$("chatTitle").ondblclick = () => {
  const s = cur();
  if (s?.type !== "chat" || !s.info.sessionId) return;
  const t = $("chatTitle");
  t.contentEditable = "true";
  t.focus();
  document.getSelection().selectAllChildren(t);
  const done = async (save) => {
    t.contentEditable = "false";
    t.onblur = t.onkeydown = null;
    if (save && t.textContent.trim()) await api.rename(s.id, t.textContent.trim());
    refreshChats();
  };
  t.onkeydown = (e) => {
    if (e.key === "Enter") (e.preventDefault(), done(true));
    if (e.key === "Escape") done(false);
  };
  t.onblur = () => done(true);
};
/** After the agents' folder changes: idle tabs start fresh there, with that folder's chats, docs and memory. */
async function workspaceChanged(ws) {
  info.workspace = ws;
  for (const s of tabs.values()) if (s.type === "chat" && !s.info.busy) clearView(s);
  await refreshProjects();
  await refreshChats();
  refreshDocs();
  refreshMemory();
  refreshWelcomes();
}
$("sbFolder").onclick = async () => {
  const ws = await api.pickWorkspace();
  if (ws) await workspaceChanged(ws);
};

// ── projects ───────────────────────────────────────────────────────────────
function findProject(list, path) {
  for (const p of list ?? []) {
    if (p.path === path) return p;
    const c = findProject(p.children, path);
    if (c) return c;
  }
  return null;
}
/** Name of the project the agents are working in, with its parent (e.g. "Kee · Meta Ray-Bans"). */
function projectName() {
  const cur = projectsState.current;
  if (!cur) return null;
  for (const g of projectsState.groups) {
    const walk = (list, parent) => {
      for (const p of list) {
        if (p.path === cur) return parent ? `${parent} · ${p.name}` : p.name;
        const c = walk(p.children ?? [], p.name);
        if (c) return c;
      }
      return null;
    };
    const n = walk(g.projects, null);
    if (n) return n;
  }
  return null;
}
function shortPath(p) {
  const home = info?.home;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
async function openProject(p) {
  if (!p.exists) return editProject({ project: p, group: null, parent: null, note: "This project's folder wasn't found. Choose where it is now." });
  try {
    const ws = await api.openProject(p.path);
    await workspaceChanged(ws);
  } catch (err) {
    modal("Project", el("p", "error-text", String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  }
}
/** Plain copy of the projects without the app's extra fields, for saving. */
function plainProjects() {
  const strip = (p) => ({ name: p.name, path: p.path, ...(p.bank && { bank: p.bank }), ...(p.children?.length && { children: p.children.map(strip) }) });
  return { groups: projectsState.groups.map((g) => ({ name: g.name, projects: g.projects.map(strip) })) };
}
/** Add a project, or edit one (rename, change folder or memory bank, move to another group or parent, remove). */
function editProject(ctx = {}) {
  const editing = ctx.project ?? null;
  const box = el("div", "sub-form project-form");
  if (ctx.note) box.appendChild(el("p", "muted", ctx.note));
  const field = (label, input, hint) => {
    const f = el("label", "field");
    f.append(el("span", "field-k", label), input);
    if (hint) f.append(el("span", "field-hint", hint));
    box.appendChild(f);
    return input;
  };
  const name = field("Name", el("input", "input"));
  name.value = editing?.name ?? "";
  name.placeholder = "e.g. Meta Ray-Bans";
  const groupIn = field("Group", el("input", "input"), "Pick one or type a new group name.");
  const groupList = el("datalist");
  groupList.id = "projectGroups";
  for (const g of projectsState.groups) groupList.appendChild(Object.assign(document.createElement("option"), { value: g.name }));
  box.appendChild(groupList);
  groupIn.setAttribute("list", "projectGroups");
  groupIn.value = ctx.group ?? projectsState.groups[0]?.name ?? "Personal";
  const parentSel = field("Inside", el("select", "input"), "Put it under another project, like Kee → Meta Ray-Bans.");
  const fillParents = () => {
    parentSel.textContent = "";
    parentSel.appendChild(Object.assign(document.createElement("option"), { value: "", textContent: "Nothing (top of the group)" }));
    const g = projectsState.groups.find((x) => x.name === groupIn.value.trim());
    const walk = (list, depth) => {
      for (const p of list) {
        if (editing && p.path === editing.path) continue; // not inside itself
        parentSel.appendChild(Object.assign(document.createElement("option"), { value: p.path, textContent: `${"  ".repeat(depth)}${p.name}` }));
        walk(p.children ?? [], depth + 1);
      }
    };
    walk(g?.projects ?? [], 0);
    parentSel.value = ctx.parent ?? "";
  };
  groupIn.oninput = fillParents;
  fillParents();
  const folderRow = el("div", "folder-pick");
  const folder = el("input", "input mono");
  folder.readOnly = true;
  folder.value = editing?.path ?? "";
  folder.placeholder = "No folder chosen";
  const choose = el("button", "btn sm", "Choose…");
  choose.onclick = async () => {
    const dir = await api.pickFolder();
    if (!dir) return;
    folder.value = dir;
    if (!name.value.trim()) name.value = folderName(dir);
  };
  folderRow.append(folder, choose);
  field("Folder", folderRow, "Agents work here. Nothing on disk is moved.");
  const bank = field("Memory bank", el("input", "input mono"), editing ? `Now: ${editing.resolvedBank}. Leave empty to use the folder's own bank (the one Claude Code uses too).` : "Leave empty to use the folder's own bank (the one Claude Code uses too).");
  bank.value = editing?.bank ?? "";
  bank.placeholder = "coding-agent::<folder>";
  const msg = el("p", "error-text");
  const acts = el("div", "row-actions");
  const save = el("button", "btn primary", editing ? "Save" : "Add project");
  acts.appendChild(save);
  if (editing) {
    const rm = el("button", "btn danger", "Remove from list");
    rm.title = "Removes it from the sidebar only. The folder and its memory stay.";
    rm.onclick = async () => {
      const data = plainProjects();
      for (const g of data.groups) removeFrom(g.projects, editing.path);
      data.groups = data.groups.filter((g) => g.projects.length);
      projectsState = await api.saveProjects(data);
      $("modal").hidden = true;
      renderStatus();
      renderPane();
    };
    acts.appendChild(rm);
  }
  box.append(msg, acts);
  save.onclick = async () => {
    const path = folder.value.trim();
    const groupName = groupIn.value.trim() || "Projects";
    if (!path) return (msg.textContent = "Choose the project's folder.");
    const data = plainProjects();
    let moved = null;
    if (editing) for (const g of data.groups) moved ??= removeFrom(g.projects, editing.path);
    const proj = { ...(moved ?? {}), name: name.value.trim() || folderName(path), path };
    if (bank.value.trim()) proj.bank = bank.value.trim();
    else delete proj.bank;
    let g = data.groups.find((x) => x.name === groupName);
    if (!g) data.groups.push((g = { name: groupName, projects: [] }));
    const parent = parentSel.value ? findProject(g.projects, parentSel.value) : null;
    if (parent) (parent.children ??= []).push(proj);
    else g.projects.push(proj);
    data.groups = data.groups.filter((x) => x.projects.length);
    try {
      projectsState = await api.saveProjects(data);
    } catch (err) {
      return (msg.textContent = String(err.message ?? err));
    }
    $("modal").hidden = true;
    renderStatus();
    renderPane();
  };
  modal(editing ? `Edit ${editing.name}` : "Add a project", box);
  (editing ? name : folder.value ? name : choose).focus();
}
/** Remove the project at `path` from a list (searching children too); returns it. */
function removeFrom(list, path) {
  const i = list.findIndex((p) => p.path === path);
  if (i >= 0) return list.splice(i, 1)[0];
  for (const p of list) {
    const r = removeFrom(p.children ?? [], path);
    if (r) {
      if (!p.children.length) delete p.children;
      return r;
    }
  }
  return null;
}

// ── composer & commands ────────────────────────────────────────────────────
function autoSize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
  $("sendBtn").disabled = !input.value.trim();
  $("changeBtn").disabled = !input.value.trim();
}
// ── @apps: name a connected MCP server in a message ───────────────────────
/** Short name after @, e.g. "plugin:small-business:stripe" → "stripe" (same rule as the engine). */
function mentionAlias(server) {
  return (server.split(/[:/]/).pop() ?? server).replace(/^claude\.ai\s+/i, "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
/** The "@partial" being typed just before the cursor, or null. */
function mentionQuery() {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = before.match(/(?:^|\s)@([a-z0-9_.:-]*)$/i);
  return m ? m[1].toLowerCase() : null;
}
function appsByAlias() {
  const map = new Map();
  for (const c of connState) if (c.enabled) map.set(mentionAlias(c.name), c);
  return map;
}
/** Servers named with @ in a message, as their real names. */
function mentionsIn(text) {
  const map = appsByAlias();
  const out = new Set();
  for (const m of text.matchAll(/(?:^|\s)@([a-z0-9_-]+)/gi)) {
    const c = map.get(m[1].toLowerCase());
    if (c) out.add(c.name);
  }
  return [...out];
}
function slashMatches() {
  const mq = mentionQuery();
  if (mq !== null) {
    const status = (c) => (c.status === "connected" ? `${c.tools} tool${c.tools === 1 ? "" : "s"}` : c.status === "needs-auth" ? "needs sign-in" : c.status);
    return [...appsByAlias()]
      .filter(([a, c]) => a.startsWith(mq) || c.name.toLowerCase().includes(mq))
      .sort(([, a], [, b]) => (a.status === "connected" ? 0 : 1) - (b.status === "connected" ? 0 : 1))
      .slice(0, 40)
      .map(([a, c]) => ({ name: `@${a}`, description: `${status(c)} · ${c.source}`, group: "Apps", mention: true }));
  }
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
      menu.appendChild(el("div", "slash-group", group));
    }
    const r = el("div", `slash-item${i === slashIndex ? " sel" : ""}`);
    r.setAttribute("role", "option");
    r.title = `${c.name}${c.args ? ` ${c.args}` : ""}\n${c.description}`;
    r.append(el("code", "", c.name), el("span", "", (c.args ? `${c.args} · ` : "") + c.description));
    r.onmousedown = (e) => (e.preventDefault(), c.mention ? pickMention(c.name) : pickSlash(c.name));
    menu.appendChild(r);
  });
  menu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
function pickMention(tag) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos).replace(/@[a-z0-9_.:-]*$/i, `${tag} `);
  input.value = before + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = before.length;
  $("slashMenu").hidden = true;
  autoSize();
  input.focus();
}
function pickSlash(c) {
  input.value = c + " ";
  $("slashMenu").hidden = true;
  autoSize();
  input.focus();
}
async function submit(mode = "send") {
  const text = input.value.trim();
  const s = cur();
  if (!text || s?.type !== "chat") return;
  input.value = "";
  autoSize();
  $("slashMenu").hidden = true;
  if (mode === "change") return api.change(s.id, text.replace(/^\/change\s*/, ""));

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = { "/clear": "/new", "/quit": "/exit", "/mcp": "/connections", "/apps": "/connections" }[rawCmd] || rawCmd;
  const arg = rest.join(" ");
  switch (cmd) {
    case "/change":
      return arg ? api.change(s.id, arg) : addNote(s, "Usage: /change <what to do differently>. While a task runs, it adjusts it at the next step without stopping.");
    case "/new":
      return newChatInTab();
    case "/exit":
      return window.close();
    case "/fork":
      return fork(arg);
    case "/btw":
      return arg ? btw(arg) : openBtw();
    case "/stop":
      return api.stop(s.id);
    case "/context":
      return showContext();
    case "/design":
      return showDesign(arg);
    case "/agents":
      return showAgents();
    case "/subagents":
      return showSubagents(arg, !!arg);
    case "/usage":
      return showUsage();
    case "/connections":
      return showConnections();
    case "/computer":
      if (!arg) return addNote(s, "Usage: /computer test (checks GPT can see the screen) or /computer <task>.");
      if (arg.trim().toLowerCase() === "test") {
        setWorking(s, `${shortModel(info.models.gui)} is taking a screenshot (computer use test)`);
        return api
          .computerTest()
          .then((r) => {
            stopWorking(s);
            addNote(s, `${r.ok ? "Computer use works." : "Computer use didn't work."} ${shortModel(info.models.gui)} says: ${r.text}\nLog: ${r.dir}`, r.ok ? "" : "error");
          })
          .catch((err) => (stopWorking(s), addNote(s, err.message, "error")));
      }
      break; // a task: goes to the agent like a normal message (expanded to use the computer_use tool)
    case "/caffeinate":
    case "/caffinate":
      return api
        .caffeinate(arg)
        .then((st) => (showAwake(st), addNote(s, describeAwake(st))))
        .catch((err) => addNote(s, String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "error"));
    case "/remote":
      return showRemote();
    case "/handoff":
      if (s.info.kind === "gpt") return addNote(s, "Hand-off works on Claude chats. This tab runs on GPT.");
      return api.handoff(s.id).catch((err) => addNote(s, err.message, "error"));
    case "/status":
      return showStatus();
    case "/models":
      return showModels();
    case "/help":
      return showHelp();
    case "/docs":
      setPane("docs");
      return arg && openDoc(arg);
    case "/summarize": {
      if (!arg) return setPane("docs");
      await openDoc(arg);
      return document.querySelector(".view:not([hidden]) .doc-head .btn.primary")?.click();
    }
    case "/chats":
      setPane("chats");
      return $("paneSearch").focus();
    case "/resume": {
      await refreshChats();
      const target = /^\d+$/.test(arg) ? allChats[Number(arg) - 1] : allChats.find((c) => c.id === arg || c.id.startsWith(arg));
      return target ? openChat(target) : addNote(s, arg ? "No such chat." : "Usage: /resume <id or number from /chats>");
    }
    case "/eval":
      return api.runEval(s.id, arg);
    case "/rename":
      if (arg) await api.rename(s.id, arg);
      return refreshChats();
    case "/verify":
      await api.setVerify(s.id, arg !== "off");
      return addNote(s, `Verifier ${arg === "off" ? "off" : "on"} for this tab.`);
    case "/model":
      if (arg) {
        $("modelSelect").value = arg;
        $("modelSelect").dispatchEvent(new Event("change"));
      }
      return addNote(s, `This tab runs on ${shortModel(arg || s.info.model)}.`);
  }
  api.send(s.id, text, mentionsIn(text));
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
    if (items[slashIndex].mention && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      return pickMention(items[slashIndex].name);
    }
    if (e.key === "Tab" || (e.key === "Enter" && items[slashIndex].name !== input.value.trim())) {
      e.preventDefault();
      return pickSlash(items[slashIndex].name);
    }
    if (e.key === "Escape") return ($("slashMenu").hidden = true);
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && cur()?.info?.busy) {
    e.preventDefault();
    return submit("change");
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
$("sendBtn").onclick = () => submit();
$("changeBtn").onclick = () => submit("change");
$("stopBtn").onclick = () => cur() && api.stop(cur().id);
$("tabAdd").onclick = () => newTab();
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "t") (e.preventDefault(), newTab());
  else if (mod && k === "w") (e.preventDefault(), active && closeTab(active));
  else if (mod && k === "n") (e.preventDefault(), newChatInTab());
  else if (mod && k === "k") (e.preventDefault(), setPane("chats"), $("paneSearch").focus());
  else if (mod && /^[1-9]$/.test(e.key)) (e.preventDefault(), order[Number(e.key) - 1] && activate(order[Number(e.key) - 1]));
  else if (e.key === "Escape") $("modal").hidden = true;
});
setInterval(() => {
  const s = cur();
  for (const t of tabs.values()) tickWorking(t);
  if (s?.type === "chat") setBusyUi(s.info.busy);
  renderStatus();
}, 1000);

// ── startup ────────────────────────────────────────────────────────────────
async function start() {
  info = await api.init();
  COMMANDS = info.commands?.length ? info.commands : [{ name: "/help", description: "All commands", group: "Harness" }];
  document.body.classList.add(`platform-${info.platform === "darwin" ? "mac" : info.platform === "win32" ? "win" : "linux"}`);
  if (info.auth.error) {
    $("blockerMsg").textContent = info.auth.error.split("\n")[0];
    $("blocker").hidden = false;
  }
  buildModelSelect();
  await refreshProjects();
  await refreshChats();
  for (const t of info.tabs) ensureChatTab(t);
  activate(info.tabs[info.tabs.length - 1].id);
  await Promise.all([refreshDocs(), refreshMemory(), refreshUsage(), refreshAgents()]);
  void loadTokenStats();
  // Re-read plan usage on the interval set in harness.config.yaml (limits.refresh_minutes).
  if (info.usageRefreshMinutes > 0) setInterval(() => (refreshUsage(), loadTokenStats(true)), info.usageRefreshMinutes * 60_000);
  refreshWelcomes();
  renderPane();
  autoSize();
  void refreshConnections();
  setInterval(refreshMemory, 30000);
}
$("retryAuth").onclick = async () => {
  await api.retryAuth();
  $("blocker").hidden = true;
  location.reload();
};
start();
