import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./state.ts";

export function savePushToken(deviceId: string, token: string): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const path = join(DATA_DIR, "push-tokens.json");
  let store: Record<string, string> = {};
  try {
    store = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    store = {};
  }
  store[deviceId] = token;
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function apnsConfigured(): boolean {
  return Boolean(process.env.OMB_APNS_KEY_P8 && process.env.OMB_APNS_KEY_ID && process.env.OMB_APNS_TEAM_ID);
}

export interface ApnsPayload {
  deviceToken: string;
  title: string;
  threadId?: string;
}

export interface ApnsAttempt {
  sent: boolean;
  reason?: string;
}

/** Closed-app push. Without Apple credentials this is a no-op by design. */
export function maybeSendApns(_payload: ApnsPayload): ApnsAttempt {
  if (!apnsConfigured()) return { sent: false, reason: "APNs credentials are not configured on this hub" };
  return { sent: false, reason: "APNs relay requires Apple Developer signing on the MacBook/iPhone release lane" };
}
