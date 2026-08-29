import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { BridgeCredentials } from "./types.ts";

const DIR = process.env.OMB_BRIDGE_DIR ?? join(homedir(), ".openmausbot-bridge");
const FILE = join(DIR, "credentials.json");

export function ensureBridgeDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { mode: 0o700, recursive: true });
}

export function loadCredentials(): BridgeCredentials | null {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as BridgeCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: BridgeCredentials): void {
  ensureBridgeDir();
  writeFileSync(FILE, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

export function credentialsPath(): string {
  return FILE;
}
