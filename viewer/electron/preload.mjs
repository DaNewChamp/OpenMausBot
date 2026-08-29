import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("viewer", {
  bots: () => ipcRenderer.invoke("viewer:bots"),
  messages: (botId) => ipcRenderer.invoke("viewer:messages", botId),
});
