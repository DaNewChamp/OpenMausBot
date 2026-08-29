import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.VBOT_VIEWER_DIR ?? join(homedir(), ".v-bot-viewer");
const FILE = join(DIR, "credentials.json");
const CURSOR_FILE = join(DIR, "cursor.json");

export function credentialsPath() {
  return FILE;
}

export function cursorPath() {
  return CURSOR_FILE;
}

export function loadCredentials() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function loadCursor() {
  try {
    const raw = JSON.parse(readFileSync(CURSOR_FILE, "utf8"));
    return typeof raw.cursor === "string" ? raw.cursor : null;
  } catch {
    return null;
  }
}

export function saveCursor(cursor) {
  if (!cursor) return;
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CURSOR_FILE, `${JSON.stringify({ cursor }, null, 2)}\n`, { mode: 0o600 });
}

export function saveCredentials(credentials) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

export function hasCredentials() {
  return existsSync(FILE);
}

export function normalizeUrl(url) {
  return String(url).replace(/\/$/, "");
}

export async function pairViewer({ url, code, deviceName }) {
  const res = await fetch(`${normalizeUrl(url)}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `pair failed (${res.status})`);
  if (!body.token) throw new Error("pair response missing token");
  const credentials = { url: normalizeUrl(url), token: body.token, deviceName, deviceId: body.deviceId };
  saveCredentials(credentials);
  return credentials;
}

export async function cloudFetch(path, init = {}) {
  const credentials = loadCredentials();
  if (!credentials) throw new Error(`not paired — run: node viewer/cli.mjs pair --url … --code …`);
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

/** Cold hydrate after hello.resumed === false. */
export async function hydrateFleet(messageLimit = 50) {
  return cloudFetch(`/api/bots?messages=${messageLimit}`);
}

export async function fetchThreadMessages(threadId, limit = 50) {
  return cloudFetch(`/api/threads/${threadId}/messages?limit=${limit}`);
}

export async function respondToRequest(threadId, requestId, behavior, message) {
  const body = { requestId, behavior };
  if (message) body.message = message;
  return cloudFetch(`/api/threads/${threadId}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function alwaysAllowTool(botId, allowKey) {
  return cloudFetch(`/api/bots/${botId}/always-allow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowKey }),
  });
}

export async function fetchLocalComputer(botId) {
  return cloudFetch(`/api/bots/${botId}/local-computer`);
}
