import { app, BrowserWindow, ipcMain } from "electron";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const viewerRoot = join(fileURLToPath(import.meta.url), "..", "..");
const credentialsFile = join(homedir(), ".v-bot-viewer", "credentials.json");

function loadCredentials() {
  return JSON.parse(readFileSync(credentialsFile, "utf8"));
}

async function cloudFetch(path, init = {}) {
  const credentials = loadCredentials();
  const res = await fetch(`${credentials.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${credentials.token}`,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

ipcMain.handle("viewer:bots", async () => cloudFetch("/api/bots?messages=20"));
ipcMain.handle("viewer:messages", async (_event, botId) => cloudFetch(`/api/bots/${botId}/messages?limit=50`));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    title: "V Bot Viewer",
    webPreferences: {
      preload: join(viewerRoot, "electron", "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadFile(join(viewerRoot, "ui", "index.html"));
});

app.on("window-all-closed", () => app.quit());
