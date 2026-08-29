import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  alwaysAllowTool,
  cloudFetch,
  fetchLocalComputer,
  fetchThreadMessages,
  hydrateFleet,
  loadCursor,
  respondToRequest,
  saveCursor,
} from "../lib/client.mjs";
import { advanceCursor, createSseParser } from "../lib/sse.mjs";

const viewerRoot = join(fileURLToPath(import.meta.url), "..", "..");

let mainWindow = null;
let sseAbort = null;
let screensEnabled = false;
let sseTask = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function stopSse() {
  sseAbort?.abort();
  sseAbort = null;
  sseTask = null;
}

async function startSse() {
  stopSse();
  const credentials = (await import("../lib/client.mjs")).loadCredentials();
  if (!credentials) return;

  const abort = new AbortController();
  sseAbort = abort;
  const cursor = loadCursor();
  const params = new URLSearchParams({ screens: screensEnabled ? "on" : "off" });
  if (cursor) params.set("since", cursor);

  const task = (async () => {
    try {
      const res = await fetch(`${credentials.url}/api/events?${params}`, {
        headers: {
          authorization: `Bearer ${credentials.token}`,
          accept: "text/event-stream",
        },
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `SSE HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("SSE response missing body");

      const parser = createSseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          await handleSseFrame(frame);
        }
      }
      for (const frame of parser.flush()) {
        await handleSseFrame(frame);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      send("viewer:error", error instanceof Error ? error.message : String(error));
      await sleep(2000);
      if (!abort.signal.aborted && mainWindow && !mainWindow.isDestroyed()) {
        startSse();
      }
    }
  })();
  sseTask = task;
}

async function handleSseFrame(frame) {
  const payload = frame.payload;
  if (!payload || typeof payload !== "object") return;

  if (payload.kind === "hello") {
    if (payload.resumed === false) {
      try {
        const fleet = await hydrateFleet(50);
        saveCursor(payload.cursor);
        send("viewer:hydrated", fleet);
      } catch (error) {
        send("viewer:error", error instanceof Error ? error.message : String(error));
        return;
      }
    } else if (payload.cursor) {
      saveCursor(payload.cursor);
    }
    send("viewer:event", { id: frame.id, ...payload });
    return;
  }

  if (frame.id) saveCursor(frame.id);
  else if (payload.seq != null) {
    const next = advanceCursor(loadCursor(), payload.seq);
    if (next) saveCursor(next);
  }

  send("viewer:event", { id: frame.id, ...payload });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

ipcMain.handle("viewer:bots", async () => cloudFetch("/api/bots?messages=50"));
ipcMain.handle("viewer:messages", async (_event, threadId) => fetchThreadMessages(threadId, 50));
ipcMain.handle("viewer:respond", async (_event, { threadId, requestId, behavior, message }) =>
  respondToRequest(threadId, requestId, behavior, message),
);
ipcMain.handle("viewer:alwaysAllow", async (_event, { botId, allowKey }) => alwaysAllowTool(botId, allowKey));
ipcMain.handle("viewer:localComputer", async (_event, botId) => fetchLocalComputer(botId));
ipcMain.handle("viewer:setScreens", async (_event, enabled) => {
  const next = Boolean(enabled);
  if (next === screensEnabled) return { screens: screensEnabled };
  screensEnabled = next;
  await startSse();
  return { screens: screensEnabled };
});

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    title: "V Bot Viewer",
    webPreferences: {
      preload: join(viewerRoot, "electron", "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    stopSse();
  });
  await mainWindow.loadFile(join(viewerRoot, "ui", "index.html"));
  await startSse();
});

app.on("window-all-closed", () => {
  stopSse();
  app.quit();
});
