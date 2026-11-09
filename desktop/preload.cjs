// Bridge between the window and the harness. The page gets only these calls.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld("harness", {
  // app
  init: () => invoke("init"),
  retryAuth: () => invoke("retry-auth"),
  chats: () => invoke("chats"),
  design: (q) => invoke("design", q),
  agents: () => invoke("agents"),
  memoryStatus: () => invoke("memory-status"),
  pickWorkspace: () => invoke("pick-workspace"),
  openConfig: () => invoke("open-config"),
  openDesignLibrary: () => invoke("open-design-library"),
  openSubagentsFile: () => invoke("open-subagents-file"),
  designSubagents: (request) => invoke("subagents-design", request),
  saveSubagents: (list) => invoke("subagents-save", list),
  removeSubagent: (name) => invoke("subagents-remove", name),
  usage: (force) => invoke("usage", force),
  models: () => invoke("models"),
  saveModels: (changes) => invoke("models-save", changes),
  connections: (reconnect) => invoke("connections", reconnect),
  mcpToggle: (name, enabled) => invoke("mcp-toggle", name, enabled),
  mcpAdd: (name, spec) => invoke("mcp-add", name, spec),
  mcpRemove: (name) => invoke("mcp-remove", name),
  mcpSignIn: () => invoke("mcp-signin"),
  answer: (tabId, id, answers) => invoke("answer", tabId, id, answers),
  change: (tabId, text) => invoke("change", tabId, text),
  context: (tabId) => invoke("context", tabId),
  docs: () => invoke("docs"),
  readDoc: (path) => invoke("doc-read", path),
  summarizeDoc: (path, force) => invoke("doc-summarize", path, force),
  openDocExternal: (path) => invoke("doc-open-external", path),
  // tabs
  newTab: (opts) => invoke("tab-new", opts),
  closeTab: (tabId) => invoke("tab-close", tabId),
  focusTab: (tabId) => invoke("tab-focus", tabId),
  tabHistory: (tabId) => invoke("tab-history", tabId),
  send: (tabId, text, mentions) => invoke("send", tabId, text, mentions),
  stop: (tabId) => invoke("stop", tabId),
  btw: (tabId, q) => invoke("btw", tabId, q),
  newChat: (tabId) => invoke("new-chat", tabId),
  openChat: (tabId, chatId, title, cwd) => invoke("open-chat", tabId, chatId, title, cwd),
  rename: (tabId, title) => invoke("rename", tabId, title),
  setVerify: (tabId, on) => invoke("set-verify", tabId, on),
  setModel: (tabId, model) => invoke("set-model", tabId, model),
  fork: (tabId, title) => invoke("fork", tabId, title),
  runEval: (tabId, filter) => invoke("eval", tabId, filter),
  // pushes
  onEvent: on("chat-event"),
  onTabs: on("tabs"),
  onFocusTab: on("focus-tab"),
});
