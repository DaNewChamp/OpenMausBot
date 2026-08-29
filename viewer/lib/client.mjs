import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.VBOT_VIEWER_DIR ?? join(homedir(), ".v-bot-viewer");
const FILE = join(DIR, "credentials.json");

export function credentialsPath() {
  return FILE;
}

export function loadCredentials() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
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
