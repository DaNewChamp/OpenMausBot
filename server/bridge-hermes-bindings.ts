import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import {
  HERMES_BRIDGE_BINDING_VERSION,
  type HermesBridgeBinding,
} from "../shared/bridge-hermes-contract.ts";

const BINDINGS_FILE = "hermes-bridge-bindings.json";
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_PROFILE_LENGTH = 64;
const MAX_BRIDGE_ID_LENGTH = 128;
const MAX_BOT_ID_LENGTH = 256;

export type HermesBridgeBindingStoreResult<T> =
  | { state: "available"; value: T }
  | {
      state: "unavailable";
      code: "state_unavailable" | "malformed_response";
      message: string;
    };

interface BindingSidecar {
  version: 1;
  bindings: Record<string, HermesBridgeBinding>;
}

function bindingsPath(): string {
  return join(DATA_DIR, BINDINGS_FILE);
}

function failure(code: "state_unavailable" | "malformed_response"): Extract<HermesBridgeBindingStoreResult<never>, { state: "unavailable" }> {
  return { state: "unavailable", code, message: code === "malformed_response" ? "Hermes returned an invalid response" : "Hermes state is unavailable" };
}

function validProfile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROFILE_LENGTH) return undefined;
  if (!PROFILE_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function validBridgeId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BRIDGE_ID_LENGTH) return undefined;
  if (/\s/.test(value)) return undefined;
  return value;
}

function validBotId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BOT_ID_LENGTH && !/\s/.test(value);
}

function normalizeBinding(value: unknown): HermesBridgeBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const bridgeId = validBridgeId(record.bridgeId);
  const profile = validProfile(record.profile);
  if (!bridgeId || !profile || record.bindingVersion !== HERMES_BRIDGE_BINDING_VERSION) return null;
  return { bridgeId, profile, bindingVersion: HERMES_BRIDGE_BINDING_VERSION };
}

function readSidecar(): HermesBridgeBindingStoreResult<BindingSidecar> {
  try {
    const parsed = JSON.parse(readFileSync(bindingsPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure("malformed_response");
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.bindings || typeof record.bindings !== "object" || Array.isArray(record.bindings)) {
      return failure("malformed_response");
    }
    const bindings: Record<string, HermesBridgeBinding> = {};
    for (const [botId, raw] of Object.entries(record.bindings as Record<string, unknown>)) {
      if (!validBotId(botId)) return failure("malformed_response");
      const binding = normalizeBinding(raw);
      if (!binding) return failure("malformed_response");
      bindings[botId] = binding;
    }
    return { state: "available", value: { version: 1, bindings } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "available", value: { version: 1, bindings: {} } };
    return failure("state_unavailable");
  }
}

export function loadHermesBridgeBindings(): HermesBridgeBindingStoreResult<ReadonlyMap<string, HermesBridgeBinding>> {
  const sidecar = readSidecar();
  if (sidecar.state === "unavailable") return sidecar;
  return { state: "available", value: new Map(Object.entries(sidecar.value.bindings)) };
}

export function setHermesBridgeBinding(
  botId: string,
  binding: HermesBridgeBinding,
): HermesBridgeBindingStoreResult<void> {
  if (!validBotId(botId)) return failure("malformed_response");
  const normalized = normalizeBinding(binding);
  if (!normalized) return failure("malformed_response");
  const current = readSidecar();
  if (current.state === "unavailable") return current;
  current.value.bindings[botId] = normalized;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(bindingsPath(), `${JSON.stringify(current.value, null, 2)}\n`, { mode: 0o600 });
  return { state: "available", value: undefined };
}

export function removeHermesBridgeBinding(botId: string): HermesBridgeBindingStoreResult<void> {
  if (!validBotId(botId)) return failure("malformed_response");
  const current = readSidecar();
  if (current.state === "unavailable") return current;
  delete current.value.bindings[botId];
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(bindingsPath(), `${JSON.stringify(current.value, null, 2)}\n`, { mode: 0o600 });
  return { state: "available", value: undefined };
}
