import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("viewer", {
  bots: () => ipcRenderer.invoke("viewer:bots"),
  messages: (threadId) => ipcRenderer.invoke("viewer:messages", threadId),
  respond: (threadId, requestId, behavior, message) =>
    ipcRenderer.invoke("viewer:respond", { threadId, requestId, behavior, message }),
  alwaysAllow: (botId, allowKey) => ipcRenderer.invoke("viewer:alwaysAllow", { botId, allowKey }),
  localComputer: (botId) => ipcRenderer.invoke("viewer:localComputer", botId),
  setScreens: (enabled) => ipcRenderer.invoke("viewer:setScreens", enabled),
  onEvent: (handler) => {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on("viewer:event", listener);
    return () => ipcRenderer.removeListener("viewer:event", listener);
  },
  onHydrated: (handler) => {
    const listener = (_event, fleet) => handler(fleet);
    ipcRenderer.on("viewer:hydrated", listener);
    return () => ipcRenderer.removeListener("viewer:hydrated", listener);
  },
  onError: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("viewer:error", listener);
    return () => ipcRenderer.removeListener("viewer:error", listener);
  },
});
