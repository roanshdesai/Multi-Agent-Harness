/* global marked, DOMPurify */
"use strict";

const api = window.harness;
const $ = (id) => document.getElementById(id);
const viewsEl = $("views");
const input = $("input");

const AGENT_COLORS = ["advisor", "coder", "researcher", "summarizer", "gui-tester", "image", "video", "designer", "verifier"];
const SUGGESTIONS = [
  ["Research", "var(--a-researcher)", "Compare the React animation libraries in my design library", "/research "],
  ["Code", "var(--a-coder)", "Build a landing page hero with Magic UI components", "/code "],
  ["Image", "var(--a-image)", "Make an app icon: a terracotta node graph, soft gradient", "Use the image agent: "],
  ["Subagents", "var(--accent)", "Suggest subagents for this project", "/subagents"],
];

let info = null;
let COMMANDS = [];
let allChats = [];
let slashIndex = 0;
/** tabId → tab state. Chat tabs mirror the host; memory tabs live only here. */
const tabs = new Map();
let order = [];
let active = null;
let memSeq = 0;

// ── helpers ────────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" ${extra}><path d="${d}"/></svg>`;
function md(text) {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
}
function agentColor(name) {
  return AGENT_COLORS.includes(name) ? `var(--a-${name})` : "var(--a-other)";
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
  return shortModel(map[agent] || "");
}
const isGpt = (m) => /^gpt-/i.test(m || "");
function spotlight(node) {
  node.classList.add("spot");
  node.addEventListener("pointermove", (e) => {
    const r = node.getBoundingClientRect();
    node.style.setProperty("--mx", `${e.clientX - r.left}px`);
    node.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
  return node;
}

// ── tab state ──────────────────────────────────────────────────────────────
function makeChatView() {
  const view = el("section", "view");
  view.setAttribute("aria-live", "polite");
  const empty = el("div", "empty");
  const h = el("h2");
  h.innerHTML = 'What should the <span class="grad">team</span> work on?';
  empty.append(h, el("p", "", "Opus plans and delegates. Fable codes and advises, Sonnet researches, GPT handles images and UI tests."));
  const sugg = el("div", "suggestions");
  for (const [label, color, text, prefix] of SUGGESTIONS) {
    const b = spotlight(el("button", "suggestion"));
    const s = el("strong");
    const dot = el("i");
    dot.style.background = color;
    s.append(dot, document.createTextNode(label));
    b.append(s, document.createTextNode(text));
    b.onclick = () => {
      input.value = prefix === "/subagents" ? "/subagents " : prefix + text;
      autoSize();
      input.focus();
    };
    sugg.appendChild(b);
  }
  empty.appendChild(sugg);
  view.appendChild(empty);
  return { view, empty };
}

function ensureChatTab(t) {
  let s = tabs.get(t.id);
  if (!s) {
    const { view, empty } = makeChatView();
    view.hidden = true;
    viewsEl.appendChild(view);
    s = { id: t.id, type: "chat", view, empty, live: null, liveText: "", timer: null, lastAgent: null, agents: new Map(), loaded: false };
    tabs.set(t.id, s);
    order.push(t.id);
  }
  s.info = t;
  return s;
}

function stateOf(id) {
  return tabs.get(id);
}
function cur() {
  return tabs.get(active);
}

// ── rendering inside a tab ─────────────────────────────────────────────────
function atBottom(v) {
  return v.scrollHeight - v.scrollTop - v.clientHeight < 140;
}
function append(s, node) {
  node.classList.add("enter");
  node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
  const stick = atBottom(s.view);
  s.empty.hidden = true;
  s.view.appendChild(node);
  if (stick) s.view.scrollTop = s.view.scrollHeight;
  return node;
}
function addUser(s, text, source, queued) {
  const m = el("div", "msg user");
  if (source === "terminal") {
    const f = el("span", "from");
    f.innerHTML = `${svg("M4 17l6-6-6-6M12 19h8")} from terminal`;
    m.appendChild(f);
  }
  m.appendChild(el("div", "bubble", text));
  append(s, m);
  s.view.scrollTop = s.view.scrollHeight;
  if (queued) addNote(s, "Queued. Runs after the current turn.");
}
function addAssistant(s, text) {
  const m = el("div", "msg assistant");
  const b = el("div", "bubble");
  b.innerHTML = md(text);
  m.appendChild(b);
  append(s, m);
}
function startLive(s) {
  const m = el("div", "msg assistant");
  s.live = el("div", "bubble streaming");
  m.appendChild(s.live);
  append(s, m);
  s.liveText = "";
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
  append(s, wrap);
  const entry = { card, tools, count, n: 0 };
  s.agents.set(id, entry);
  s.lastAgent = entry;
}
function addTool(s, name, summary, sub) {
  if (name === "AskUserQuestion") return; // shown as a question card instead
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
  append(s, w);
}
function finishAgents(s) {
  for (const c of s.agents.values()) c.card.classList.add("done");
}
function addVerify(s, e) {
  endLive(s);
  const existing = s.view.querySelector(".verify.running");
  if (e.status === "running") {
    finishAgents(s);
    const v = el("div", "verify running");
    const badge = el("span", "badge");
    const spin = el("span", "spinner");
    spin.style.setProperty("--c", "var(--a-verifier)");
    badge.append(spin, document.createTextNode(`Verifier checking${e.round > 1 ? ` (round ${e.round})` : ""}`));
    v.append(badge, el("span", "", modelFor("verifier")));
    append(s, v);
    return;
  }
  if (existing) existing.remove();
  const v = el("div", `verify ${e.status}`);
  const badge = el("span", "badge", e.status === "pass" ? "✓ Verified" : "✕ Verifier found problems, fixing");
  v.append(badge, el("span", "", modelFor("verifier")));
  append(s, v);
  if (e.status === "fail" && e.feedback) {
    const d = el("div", "verify-detail", e.feedback.slice(0, 3000));
    d.hidden = true;
    badge.onclick = () => (d.hidden = !d.hidden);
    append(s, d);
  }
}
function addNote(s, text, cls = "") {
  append(s, el("div", `note ${cls}`, text));
}
function clearView(s) {
  s.live = null;
  s.lastAgent = null;
  s.agents.clear();
  [...s.view.children].forEach((n) => n !== s.empty && n.remove());
  s.empty.hidden = false;
}
function renderHistory(s, items) {
  clearView(s);
  for (const it of items) {
    if (it.role === "user") addUser(s, it.text);
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
  s.view.scrollTop = s.view.scrollHeight;
}

// ── questions from the agent (AskUserQuestion) ─────────────────────────────
function addQuestion(s, id, questions) {
  endLive(s);
  const card = el("div", "question");
  card.dataset.qid = id;
  const picks = new Map(); // question text → Set(labels)
  const others = new Map();
  for (const q of questions) {
    const head = el("div", "q-head");
    head.innerHTML = `${svg("M12 18h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3")} ${q.header ? q.header : "Question"}`;
    card.append(head, el("div", "q-text", q.question));
    const opts = el("div", "opts");
    picks.set(q.question, new Set());
    for (const o of q.options) {
      const b = el("button", "opt");
      b.append(el("span", "", o.label));
      if (o.description) b.append(el("small", "", o.description));
      b.onclick = () => {
        const set = picks.get(q.question);
        if (!q.multiSelect) {
          set.clear();
          opts.querySelectorAll(".opt").forEach((n) => n.classList.remove("picked"));
        }
        if (set.has(o.label)) set.delete(o.label);
        else set.add(o.label);
        b.classList.toggle("picked", set.has(o.label));
        if (!q.multiSelect && questions.length === 1) submitAnswers();
      };
      opts.appendChild(b);
    }
    const other = el("div", "other");
    const inp = el("input");
    inp.placeholder = "Something else…";
    others.set(q.question, inp);
    inp.onkeydown = (e) => e.key === "Enter" && submitAnswers();
    other.appendChild(inp);
    card.append(opts, other);
  }
  const acts = el("div", "q-actions");
  const skip = el("button", "ghost", "Skip");
  const send = el("button", "primary", "Answer");
  acts.append(skip, send);
  card.append(acts, el("div", "q-answer", ""));
  function submitAnswers() {
    const answers = {};
    for (const q of questions) {
      const typed = others.get(q.question).value.trim();
      const chosen = [...picks.get(q.question)];
      answers[q.question] = typed || chosen.join(", ") || "(no answer)";
    }
    api.answer(s.id, id, answers);
  }
  send.onclick = submitAnswers;
  skip.onclick = () => api.answer(s.id, id, Object.fromEntries(questions.map((q) => [q.question, "(skipped, use your judgment)"])));
  append(s, card);
  s.view.scrollTop = s.view.scrollHeight;
  if (s.id !== active) renderTabs();
}
function markAnswered(s, id, answers) {
  const card = s.view.querySelector(`.question[data-qid="${id}"]`);
  if (!card) return;
  card.classList.add("done");
  card.querySelector(".q-answer").textContent = `Answered: ${Object.values(answers).join(" · ") || "skipped"}`;
}

// ── advisor (consulted automatically, like Claude Code) ────────────────────
function addAdvice(s, status) {
  if (status === "answered") {
    const last = [...s.view.querySelectorAll(".advice")].pop();
    if (last) {
      last.querySelector(".spinner")?.remove();
      last.querySelector(".txt").textContent = "Consulted the advisor";
    }
    return;
  }
  endLive(s);
  const a = el("div", "advice");
  const chip = el("span", "agent-chip");
  chip.append(el("span", "", "advisor"), el("span", "model", shortModel(info.models.advisor)));
  const spin = el("span", "spinner");
  spin.style.setProperty("--c", "var(--a-advisor)");
  a.append(chip, el("span", "txt", "Hit something hard, asking the advisor…"), spin);
  append(s, a);
}

// ── usage ──────────────────────────────────────────────────────────────────
let usageState = null;
function fmtReset(at) {
  if (!at) return "";
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
function meter(w) {
  const pct = w.utilization == null ? null : Math.round(w.utilization * 100);
  const m = el("div", `meter${pct >= 100 || w.status === "rejected" ? " full" : pct >= 80 ? " warn" : ""}`);
  m.append(el("span", "", w.label), el("span", "", pct == null ? "?" : `${pct}%`));
  const bar = el("div", "bar");
  const fill = el("i");
  fill.style.width = `${Math.min(100, pct ?? 0)}%`;
  bar.appendChild(fill);
  m.appendChild(bar);
  if (w.resetsAt) m.title = `Resets ${fmtReset(w.resetsAt)}`;
  return m;
}
async function refreshUsage(u) {
  usageState = u ?? (await api.usage());
  const box = $("usageBtn");
  box.textContent = "";
  const windows = usageState.usage?.windows ?? [];
  if (!windows.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const w of windows.filter((w) => ["five_hour", "seven_day"].includes(w.key))) box.appendChild(meter(w));
}
async function showUsage() {
  await refreshUsage();
  const u = usageState;
  const box = el("div", "usage-big");
  box.appendChild(el("div", "chat-group", "Claude plan"));
  if (!u.usage?.windows?.length) box.appendChild(el("p", "", "No usage reported yet. It shows up after your first message."));
  for (const w of u.usage?.windows ?? []) {
    const m = meter(w);
    if (w.resetsAt) m.appendChild(el("span", "", `Resets ${fmtReset(w.resetsAt)}`));
    box.appendChild(m);
  }
  if (u.usage) box.appendChild(el("p", "", `As of ${new Date(u.usage.at).toLocaleTimeString()}.`));
  box.appendChild(el("div", "chat-group", "ChatGPT plan"));
  box.appendChild(el("p", "", u.codex.ok ? `Signed in. ${u.gpt} is ready.` : u.codex.detail));
  const c = el("div", `callout${u.limited ? " bad" : ""}`);
  c.textContent = u.limited
    ? `Claude is at its limit until ${fmtReset(u.usage?.resetsAt)}. New tasks and the task that hit the limit continue on ${shortModel(u.gpt)}.`
    : `If Claude runs out, the task that hit the limit continues on ${shortModel(u.gpt)} with your ChatGPT plan, and new tabs start there until Claude resets.`;
  box.appendChild(c);
  modal("Usage", box);
}
$("usageBtn").onclick = showUsage;

// ── connections: MCP servers and apps ──────────────────────────────────────
let connState = [];
function connSummary(list) {
  const on = list.filter((c) => c.status === "connected").length;
  const bad = list.filter((c) => ["failed", "needs-auth"].includes(c.status)).length;
  $("connCount").textContent = `${on} connected${bad ? ` · ${bad} need attention` : ""}`;
  $("connDot").className = `dot ${bad ? "warn" : on ? "ok" : ""}`;
}
async function refreshConnections(reconnect) {
  connState = await api.connections(reconnect);
  connSummary(connState);
  return connState;
}
async function showConnections() {
  const box = el("div");
  const render = async (reconnect) => {
    box.textContent = "";
    box.appendChild(el("p", "", reconnect ? `Reconnecting ${reconnect}…` : "Checking servers…"));
    const list = await refreshConnections(reconnect);
    box.textContent = "";
    // Accounts & memory apps
    box.appendChild(el("div", "chat-group", "Accounts & apps"));
    const apps = [
      { name: "Claude plan", ok: !!info.auth.plan || !info.subscriptionOnly, sub: info.auth.plan ? `Signed in (${info.auth.plan})` : !info.subscriptionOnly ? "API billing allowed (HARNESS_ALLOW_API=1)" : info.auth.error?.split("\n")[0] || "Not signed in" },
      { name: "ChatGPT plan (Codex)", ok: info.codex.ok, sub: info.codex.detail },
      { name: "claude-mem", ok: memStatus?.claudeMem.up, sub: memStatus?.claudeMem.up ? memStatus.claudeMem.url : "Not running" },
      { name: "Hindsight", ok: memStatus?.hindsight.up, sub: memStatus?.hindsight.up ? memStatus.hindsight.url : "Not running (docker compose up -d hindsight)" },
    ];
    for (const a of apps) {
      const r = el("div", "conn-row");
      r.append(el("span", `status-dot ${a.ok ? "connected" : "failed"}`), el("div", "name", a.name), el("div", "sub", a.sub));
      box.appendChild(r);
    }
    // MCP servers
    box.appendChild(el("div", "chat-group", `MCP servers (${list.length})`));
    if (!list.length) box.appendChild(el("p", "", "No MCP servers found."));
    for (const c of list) {
      const r = el("div", "conn-row");
      const name = el("div", "name", c.name);
      name.appendChild(el("span", "src", c.source));
      const detail =
        c.status === "connected"
          ? `${c.tools} tool${c.tools === 1 ? "" : "s"}${c.target ? ` · ${c.target}` : ""}`
          : c.status === "needs-auth"
            ? "Needs sign-in: open Claude Code (claude), run /mcp, and sign in to it"
            : c.status === "disabled"
              ? "Turned off"
              : c.error || c.target || c.status;
      const sub = el("div", "sub", detail);
      sub.title = detail;
      const acts = el("div", "acts");
      if (["failed", "needs-auth", "pending"].includes(c.status)) {
        const rc = el("button", "ghost", "Reconnect");
        rc.onclick = () => render(c.name);
        acts.appendChild(rc);
      }
      const tg = el("button", "ghost", c.enabled ? "Turn off" : "Turn on");
      tg.onclick = async () => {
        await api.mcpToggle(c.name, !c.enabled);
        render();
      };
      acts.appendChild(tg);
      if (c.removable) {
        const rm = el("button", "ghost", "Remove");
        rm.onclick = async () => {
          await api.mcpRemove(c.name);
          render();
        };
        acts.appendChild(rm);
      }
      r.append(el("span", `status-dot ${c.status}`), name, sub, acts);
      box.appendChild(r);
    }
    // Add
    box.appendChild(el("div", "chat-group", "Add an MCP server"));
    const form = el("div", "add-conn");
    const nm = el("input");
    nm.placeholder = "Name, e.g. notion";
    const spec = el("input");
    spec.placeholder = "URL (https://…) or command (npx -y some-mcp-server)";
    const add = el("button", "primary", "Add");
    add.onclick = async () => {
      try {
        await api.mcpAdd(nm.value, spec.value);
        render();
      } catch (err) {
        add.textContent = "Check the name and address";
      }
    };
    form.append(nm, spec, add);
    box.appendChild(form);
    box.appendChild(el("p", "", "Servers you add are saved in mcp-servers.json and available to every tab from the next message. Servers from your Claude Code setup and claude.ai connectors show up here automatically."));
  };
  modal("MCP servers & apps", box);
  render();
}
$("connBtn").onclick = showConnections;

// ── events from the engine, per tab ────────────────────────────────────────
api.onEvent(({ tabId, event: e }) => {
  const s = stateOf(tabId);
  if (!s) return;
  switch (e.type) {
    case "user":
      addUser(s, e.text, e.source, e.queued);
      break;
    case "busy":
      if (!e.busy) {
        endLive(s);
        finishAgents(s);
        refreshChats();
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
      break;
    case "agent":
      addAgent(s, e.id, e.agent, e.description);
      break;
    case "tool":
      addTool(s, e.name, e.summary, e.sub);
      break;
    case "verify":
      addVerify(s, e);
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
      addNote(s, e.text, /^FAIL/.test(e.text) ? "error" : /usage limit/.test(e.text) ? "error" : "");
      break;
    case "question":
      addQuestion(s, e.id, e.questions);
      break;
    case "question-answered":
      markAnswered(s, e.id, e.answers);
      break;
    case "advisor":
      addAdvice(s, e.status);
      break;
    case "usage":
      refreshUsage();
      break;
  }
});

// Host tab list → reconcile chat tabs (memory tabs are local).
api.onTabs((list) => {
  const seen = new Set();
  for (const t of list) {
    ensureChatTab(t);
    seen.add(t.id);
  }
  for (const [id, s] of tabs) {
    if (s.type === "chat" && !seen.has(id)) removeTabLocal(id);
  }
  renderTabs();
  syncTopbar();
});
api.onFocusTab((id) => {
  if (tabs.has(id)) activate(id);
});

// ── tab bar ────────────────────────────────────────────────────────────────
function renderTabs() {
  const bar = $("tabs");
  bar.textContent = "";
  for (const id of order) {
    const s = tabs.get(id);
    if (!s) continue;
    const isMem = s.type === "memory";
    const b = el("div", `tab${id === active ? " active" : ""}${!isMem && s.info.busy ? " busy" : ""}`);
    b.setAttribute("role", "tab");
    b.tabIndex = 0;
    const dot = el("span", `tab-dot${isMem ? " mem" : isGpt(s.info?.model) ? " gpt" : ""}`);
    const title = isMem ? s.title : s.info.title;
    const x = el("button", "x");
    x.innerHTML = svg("M6 6l12 12M18 6L6 18");
    x.title = "Close tab (⌘W)";
    x.onclick = (e) => {
      e.stopPropagation();
      closeTab(id);
    };
    b.append(dot, el("span", "t", title), x);
    b.title = isMem ? s.title : `${s.info.title} · ${shortModel(s.info.model)}${s.info.busy ? " · working" : ""}`;
    b.onclick = () => activate(id);
    b.onauxclick = (e) => e.button === 1 && closeTab(id);
    bar.appendChild(b);
  }
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
  }
  renderTabs();
  syncTopbar();
  markActiveChat();
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

// ── top bar ────────────────────────────────────────────────────────────────
function syncTopbar() {
  const s = cur();
  if (!s) return;
  const chat = s.type === "chat";
  $("topbar").querySelectorAll(".top-actions > *").forEach((n) => (n.hidden = !chat));
  $("composerWrap").hidden = !chat;
  $("chatTitle").textContent = chat ? s.info.title : s.title;
  if (!chat) return;
  $("verifyBtn").classList.toggle("on", s.info.verify);
  $("verifyBtn").hidden = s.info.kind === "gpt";
  $("forkBtn").hidden = s.info.kind === "gpt";
  $("modelSelect").value = s.info.model;
  $("modelDot").classList.toggle("gpt", isGpt(s.info.model));
  setBusyUi(s.info.busy);
}
function setBusyUi(b) {
  $("sendBtn").hidden = b;
  $("stopBtn").hidden = !b;
  $("composer").classList.toggle("running", b);
  const hint = $("hint");
  hint.classList.toggle("working", b);
  const running = [...tabs.values()].filter((t) => t.type === "chat" && t.info.busy).length;
  hint.textContent = b
    ? "Working… queue another message, ask a btw, or open a new tab (⌘T) for another task"
    : running
      ? `${running} task${running === 1 ? "" : "s"} running in other tabs · Enter to send`
      : "Enter to send · Shift+Enter for a new line · ⌘T new tab · only GitHub pushes ask for approval";
}
function buildModelSelect() {
  const sel = $("modelSelect");
  sel.textContent = "";
  const claude = el("optgroup");
  claude.label = "Claude · your Claude plan";
  for (const m of [...new Set([info.models.main, info.models.advisor, info.models.worker])]) {
    const o = el("option", "", shortModel(m));
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
  sel.append(claude, gpt);
}
$("modelSelect").onchange = async (e) => {
  const s = cur();
  const model = e.target.value; // read before the tab list refresh resets the picker
  const r = await api.setModel(s.id, model);
  if (r.newTab) {
    const t = ensureChatTab({ id: r.tabId, kind: isGpt(model) ? "gpt" : "claude", model, title: "New chat", busy: false, verify: true, sessionId: null });
    t.loaded = true;
    activate(r.tabId);
    addNote(t, `${shortModel(model)} can't continue a ${isGpt(model) ? "Claude" : "GPT"} conversation, so it opened in a new tab.`);
  }
};
$("verifyBtn").onclick = async () => {
  const s = cur();
  await api.setVerify(s.id, !s.info.verify);
};

// ── sidebar: chats ─────────────────────────────────────────────────────────
function groupLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = (today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function openSessionIds() {
  return new Set([...tabs.values()].filter((t) => t.type === "chat" && t.info.sessionId).map((t) => t.info.sessionId));
}
function renderChats() {
  const q = $("chatSearch").value.trim().toLowerCase();
  const list = $("chatList");
  list.textContent = "";
  const open = openSessionIds();
  let group = "";
  for (const c of allChats.filter((c) => !q || (c.title || "").toLowerCase().includes(q))) {
    const g = groupLabel(c.updated);
    if (g !== group) {
      group = g;
      list.appendChild(el("div", "chat-group", g));
    }
    const b = el("button", "chat-item");
    b.dataset.id = c.id;
    b.title = c.title;
    if (open.has(c.id)) b.appendChild(el("span", "open-dot"));
    b.appendChild(el("span", "t", c.title || "Untitled"));
    if (c.kind === "gpt") b.appendChild(el("span", "badge-gpt", "GPT"));
    b.onclick = () => openChat(c);
    list.appendChild(b);
  }
  markActiveChat();
}
function markActiveChat() {
  const sid = cur()?.info?.sessionId;
  document.querySelectorAll(".chat-item").forEach((n) => n.classList.toggle("active", !!sid && n.dataset.id === sid));
  document.querySelectorAll(".side-item.mem").forEach((n) => n.classList.toggle("active", cur()?.type === "memory" && cur().mem === n.dataset.mem));
}
async function refreshChats() {
  allChats = await api.chats();
  renderChats();
}
async function openChat(c) {
  // Already open? Focus that tab.
  for (const [id, t] of tabs) if (t.type === "chat" && t.info.sessionId === c.id) return activate(id);
  const s = cur();
  const reuse = s && s.type === "chat" && !s.info.sessionId && !s.info.busy;
  if (reuse) {
    try {
      const history = await api.openChat(s.id, c.id, c.title);
      s.loaded = true;
      renderHistory(s, history);
      markActiveChat();
    } catch (err) {
      addNote(s, err.message, "error");
    }
    return;
  }
  const t = await newTab({ chatId: c.id, title: c.title });
  t.loaded = true;
  renderHistory(t, await api.tabHistory(t.id));
}
async function newChatInTab() {
  const s = cur();
  if (!s || s.type !== "chat") return newTab();
  if (s.info.busy) return newTab();
  await api.newChat(s.id);
  clearView(s);
  input.focus();
}

// ── sidebar: memory (claude-mem, Hindsight) ────────────────────────────────
const MEM = {
  claudeMem: { title: "claude-mem", start: ["claude-mem runs inside Claude Code. Open Claude Code once in any project so its worker starts.", "Its viewer usually lives at localhost:37777 (yours showed 37701)."] },
  hindsight: { title: "Hindsight", start: ["Start it from the agent-harness folder:", "docker compose up -d hindsight", "The web UI runs on localhost:9999 and the API on 8888."] },
};
let memStatus = null;
async function refreshMemory() {
  memStatus = await api.memoryStatus();
  for (const [key, btn] of [["claudeMem", $("memClaudeMem")], ["hindsight", $("memHindsight")]]) {
    const st = memStatus[key];
    btn.querySelector("[data-status]").className = `dot ${st.up ? "ok" : ""}`;
    btn.title = st.up ? `${MEM[key].title} at ${st.url}` : `${MEM[key].title} isn't running`;
  }
}
async function openMemory(key) {
  for (const [id, t] of tabs) if (t.type === "memory" && t.mem === key) return activate(id);
  await refreshMemory();
  const st = memStatus[key];
  const id = `m${++memSeq}`;
  const view = el("section", "view mem-view");
  view.hidden = true;
  const s = { id, type: "memory", mem: key, title: MEM[key].title, view };
  if (st.up) {
    const wrap = el("div", "mem-wrap");
    const head = el("div", "mem-head");
    const reload = el("button", "ghost", "Reload");
    const ext = el("button", "ghost", "Open in browser");
    head.append(el("span", "url", st.url), reload, ext);
    const frame = el("iframe", "mem-frame");
    frame.src = st.url;
    reload.onclick = () => (frame.src = st.url);
    ext.onclick = () => window.open(st.url, "_blank");
    wrap.append(head, frame);
    view.appendChild(wrap);
  } else {
    const off = el("div", "mem-off");
    off.append(el("h2", "", `${MEM[key].title} isn't running`));
    for (const line of MEM[key].start) off.appendChild(line.startsWith("docker") ? Object.assign(el("pre"), { textContent: line }) : el("p", "", line));
    const retry = el("button", "primary", "Check again");
    retry.onclick = async () => {
      await closeTab(id);
      openMemory(key);
    };
    off.appendChild(retry);
    view.appendChild(off);
  }
  viewsEl.appendChild(view);
  tabs.set(id, s);
  order.push(id);
  activate(id);
}
$("memClaudeMem").onclick = () => openMemory("claudeMem");
$("memHindsight").onclick = () => openMemory("hindsight");

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

function agentRow(a, onRemove) {
  const r = el("div", "agent-row");
  const chip = el("span", "agent-chip");
  chip.style.setProperty("--c", agentColor(a.name));
  chip.append(el("span", "", a.name), el("span", "model", a.runsOn ? shortModel(a.runsOn.split(" ")[0]) : shortModel(a.model || "")));
  const p = el("p", "", a.description);
  if (a.custom) p.prepend(el("span", "tag-mine", "yours"), document.createTextNode(" "));
  r.append(chip, p);
  if (onRemove) {
    const x = el("button", "ghost", "Remove");
    x.onclick = () => onRemove(a.name);
    r.appendChild(x);
  } else r.appendChild(el("span"));
  return r;
}

async function showAgents() {
  const box = el("div");
  for (const a of await api.agents()) box.appendChild(agentRow(a));
  modal("The team", box);
}

/** /subagents: list, design with the advisor, review, save. */
async function showSubagents(prefill = "", autoRun = false) {
  const box = el("div");
  const team = el("div");
  const renderTeam = async () => {
    team.textContent = "";
    const agents = await api.agents();
    $("teamCount").textContent = `${agents.length} agents · ${agents.filter((a) => a.custom).length} yours`;
    for (const a of agents)
      team.appendChild(
        agentRow(
          a,
          a.custom
            ? async (name) => {
                await api.removeSubagent(name);
                renderTeam();
              }
            : null,
        ),
      );
  };
  await renderTeam();

  const form = el("div", "sub-form");
  form.style.marginTop = "0";
  const ta = el("textarea");
  ta.placeholder = "Describe the subagents you want, e.g. \"an SEO writer on Sonnet and a GPT-6 Astra copy critic\".\nLeave it empty and the Fable advisor will look at this project and suggest some.";
  ta.value = prefill;
  const go = el("button", "primary", "Design with the advisor");
  const status = el("span", "muted", "");
  const row = el("div", "row");
  const file = el("button", "ghost", "Edit subagents.yaml");
  file.onclick = () => api.openSubagentsFile();
  row.append(go, status, file);
  const results = el("div");
  form.append(ta, row, results);

  go.onclick = async () => {
    go.disabled = true;
    results.textContent = "";
    status.textContent = ta.value.trim() ? "The advisor is designing your subagents…" : "The advisor is looking at your project…";
    status.className = "muted hint working";
    try {
      const { summary, subagents } = await api.designSubagents(ta.value);
      status.textContent = "";
      status.className = "muted";
      if (summary) results.appendChild(el("p", "", summary));
      const picks = [];
      for (const a of subagents) {
        const card = el("div", "proposal");
        const label = el("label");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = true;
        picks.push([cb, a]);
        const chip = el("span", "agent-chip");
        chip.style.setProperty("--c", agentColor(a.name));
        chip.append(el("span", "", a.name), el("span", "model", shortModel(a.model)));
        label.append(cb, chip);
        const det = el("details");
        det.append(el("summary", "", "System prompt"), Object.assign(el("pre"), { textContent: a.prompt }));
        card.append(label, el("p", "", a.description), det);
        results.appendChild(card);
      }
      const save = el("button", "primary", "Add selected to the team");
      save.style.marginTop = "12px";
      save.onclick = async () => {
        const chosen = picks.filter(([cb]) => cb.checked).map(([, a]) => a);
        if (!chosen.length) return;
        await api.saveSubagents(chosen);
        results.textContent = "";
        results.appendChild(el("p", "", `Added ${chosen.map((a) => a.name).join(", ")}. The orchestrator can use them from your next message.`));
        renderTeam();
      };
      results.appendChild(save);
      results.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      status.textContent = err.message;
      status.className = "muted";
    } finally {
      go.disabled = false;
    }
  };

  const teamLabel = el("div", "chat-group", "Current team");
  box.append(form, teamLabel, team);
  modal("Subagents", box);
  if (autoRun) go.click();
}
$("teamBtn").onclick = () => showSubagents();

function showStatus() {
  const dl = el("dl", "kv");
  const row = (k, v) => dl.append(el("dt", "", k), el("dd", "", v));
  const s = cur();
  row("Billing", info.subscriptionOnly ? "Subscriptions only" : "API keys allowed (HARNESS_ALLOW_API=1)");
  row("Claude plan", info.auth.plan || info.auth.error || "unknown");
  row("ChatGPT (Codex)", info.codex.detail);
  if (s?.type === "chat") row("This tab", `${shortModel(s.info.model)}${s.info.busy ? " · working" : ""}`);
  for (const [k, v] of Object.entries(info.models)) row(k, Array.isArray(v) ? v.join(", ") : v);
  row("Folder", info.workspace);
  row("Plugins", info.plugins.join(", ") || "none (run npm run setup)");
  row("Not connected", info.mcpSkipped.join("; ") || "all configured");
  row("UI links", `${info.designCount} links`);
  row("Terminal link", "Run npm start in a terminal while this app is open to join the same tabs");
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
  box.appendChild(el("p", "", "Shortcuts: ⌘T new tab · ⌘W close tab · ⌘1–9 switch tabs · ⌘K search chats · ⌘N new chat in this tab"));
  modal("Commands", box);
}

// ── btw ────────────────────────────────────────────────────────────────────
function openBtw() {
  $("btwPanel").hidden = false;
  $("btwInput").focus();
}
async function btw(q) {
  const s = cur();
  if (!s || s.type !== "chat") return;
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
  if (!s || s.type !== "chat" || !s.info.sessionId) return;
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
$("workspaceBtn").onclick = async () => {
  const ws = await api.pickWorkspace();
  if (!ws) return;
  info.workspace = ws;
  $("workspaceName").textContent = ws.split(/[\\/]/).pop() || ws;
  $("workspaceBtn").title = ws;
  for (const s of tabs.values()) if (s.type === "chat" && !s.info.busy) clearView(s);
  refreshChats();
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
  const s = cur();
  if (!text || !s || s.type !== "chat") return;
  input.value = "";
  autoSize();
  $("slashMenu").hidden = true;

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = { "/clear": "/new", "/quit": "/exit" }[rawCmd] || rawCmd;
  const arg = rest.join(" ");
  switch (cmd) {
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
    case "/design":
      return showDesign(arg);
    case "/agents":
      return showAgents();
    case "/subagents":
      return showSubagents(arg, !!arg);
    case "/usage":
      return showUsage();
    case "/connections":
    case "/mcp":
    case "/apps":
      return showConnections();
    case "/status":
      return showStatus();
    case "/help":
      return showHelp();
    case "/chats":
      $("chatSearch").focus();
      return refreshChats();
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
  api.send(s.id, text);
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
$("stopBtn").onclick = () => cur() && api.stop(cur().id);
$("newTabBtn").onclick = () => newTab();
$("tabAdd").onclick = () => newTab();
$("chatSearch").oninput = renderChats;
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "t") (e.preventDefault(), newTab());
  else if (mod && k === "w") (e.preventDefault(), active && closeTab(active));
  else if (mod && k === "n") (e.preventDefault(), newChatInTab());
  else if (mod && k === "k") (e.preventDefault(), $("chatSearch").focus());
  else if (mod && /^[1-9]$/.test(e.key)) (e.preventDefault(), order[Number(e.key) - 1] && activate(order[Number(e.key) - 1]));
  else if (e.key === "Escape") $("modal").hidden = true;
});

// busy state follows the active tab
setInterval(() => cur()?.type === "chat" && setBusyUi(cur().info.busy), 500);

// ── startup ────────────────────────────────────────────────────────────────
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
    line(info.codex.ok ? "ok" : "warn", info.codex.ok ? "ChatGPT · GPT models" : "ChatGPT not signed in");
  } else line("warn", "API billing allowed");
}

async function start() {
  info = await api.init();
  COMMANDS = info.commands?.length ? info.commands : [{ name: "/help", description: "All commands", group: "Harness" }];
  document.body.classList.add(`platform-${info.platform === "darwin" ? "mac" : info.platform === "win32" ? "win" : "linux"}`);
  if (info.auth.error) {
    $("blockerMsg").textContent = info.auth.error.split("\n")[0];
    $("blocker").hidden = false;
  }
  $("workspaceName").textContent = info.workspace.split(/[\\/]/).pop() || info.workspace;
  $("workspaceBtn").title = info.workspace;
  buildModelSelect();
  renderPlans();
  for (const t of info.tabs) ensureChatTab(t);
  activate(info.tabs[info.tabs.length - 1].id);
  await Promise.all([refreshChats(), refreshMemory(), refreshUsage()]);
  void refreshConnections();
  const agents = await api.agents();
  $("teamCount").textContent = `${agents.length} agents · ${agents.filter((a) => a.custom).length} yours`;
  autoSize();
  setInterval(refreshMemory, 30000);
}
$("retryAuth").onclick = async () => {
  await api.retryAuth();
  $("blocker").hidden = true;
  location.reload();
};
start();
