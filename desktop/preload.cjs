// Bridge between the window and the harness. The page gets only these calls.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harness", {
  init: () => ipcRenderer.invoke("init"),
  retryAuth: () => ipcRenderer.invoke("retry-auth"),
  send: (text) => ipcRenderer.invoke("send", text),
  stop: () => ipcRenderer.invoke("stop"),
  btw: (q) => ipcRenderer.invoke("btw", q),
  newChat: () => ipcRenderer.invoke("new-chat"),
  openChat: (id) => ipcRenderer.invoke("open-chat", id),
  chats: () => ipcRenderer.invoke("chats"),
  fork: (title) => ipcRenderer.invoke("fork", title),
  rename: (title) => ipcRenderer.invoke("rename", title),
  setVerify: (on) => ipcRenderer.invoke("set-verify", on),
  setModel: (m) => ipcRenderer.invoke("set-model", m),
  design: (q) => ipcRenderer.invoke("design", q),
  agents: () => ipcRenderer.invoke("agents"),
  pickWorkspace: () => ipcRenderer.invoke("pick-workspace"),
  openConfig: () => ipcRenderer.invoke("open-config"),
  openDesignLibrary: () => ipcRenderer.invoke("open-design-library"),
  onEvent: (cb) => {
    const listener = (_e, ev) => cb(ev);
    ipcRenderer.on("chat-event", listener);
    return () => ipcRenderer.removeListener("chat-event", listener);
  },
});
