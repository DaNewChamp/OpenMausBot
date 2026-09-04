import type { RuntimeEvent } from "../server/contracts.ts";
import {
  scrubRuntimeEvents,
  type ScrubbedRuntimeEvent,
  wireContainsForbiddenMaterial,
} from "./bridge-hermes-contract.ts";

export const FLEET_MODEL_PREFIX = "fleet/";
export const DEFAULT_FLEET_DISCOVERY_INTERVAL_MS = 60_000;
export const FLEET_CHAT_MAX_EVENTS = 64;
export const FLEET_CHAT_MAX_MESSAGES = 80;
export const FLEET_CHAT_MAX_MESSAGE_CHARS = 16_384;

export type LocalModelServerKind = "ollama" | "lmstudio" | "openai-compat";

export interface LocalModelDescriptor {
  id: string;
  name: string;
}

export interface LocalModelServer {
  kind: LocalModelServerKind;
  baseUrl: string;
  models: LocalModelDescriptor[];
}

export interface LocalModelsPayload {
  kind: "local-models";
  servers: LocalModelServer[];
}

export interface FleetChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FleetChatJobPayload {
  baseUrl: string;
  model: string;
  messages: FleetChatMessage[];
  threadId: string;
  turnId: string;
}

export interface FleetChatWire {
  ok: boolean;
  turnId: string;
  events: ScrubbedRuntimeEvent[];
}

export type FleetChatResultWire = { kind: "fleet-chat"; body: FleetChatWire };

export interface ParsedFleetModelId {
  machineSlug: string;
  modelId: string;
}

const SERVER_KINDS = new Set<LocalModelServerKind>(["ollama", "lmstudio", "openai-compat"]);
const MESSAGE_ROLES = new Set<FleetChatMessage["role"]>(["system", "user", "assistant"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function machineSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "bridge";
}

export function fleetModelId(slug: string, modelId: string): string {
  return `${FLEET_MODEL_PREFIX}${slug}/${modelId}`;
}

export function parseFleetModelId(value: unknown): ParsedFleetModelId | null {
  if (typeof value !== "string" || !value.startsWith(FLEET_MODEL_PREFIX)) return null;
  const rest = value.slice(FLEET_MODEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const machine = rest.slice(0, slash);
  const modelId = rest.slice(slash + 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(machine)) return null;
  if (!modelId.trim() || modelId.length > 200) return null;
  return { machineSlug: machine, modelId };
}

export function isLoopbackModelBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.pathname.includes("..")) return false;
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeModelBaseUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || !isLoopbackModelBaseUrl(trimmed)) return null;
  return trimmed;
}

export function serverKindForBaseUrl(baseUrl: string): LocalModelServerKind {
  try {
    const port = Number(new URL(baseUrl).port);
    if (port === 11434) return "ollama";
    if (port === 1234) return "lmstudio";
  } catch {
    /* fall through */
  }
  return "openai-compat";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalModelDescriptor(value: unknown): value is LocalModelDescriptor {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 200) return false;
  if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 200) return false;
  return true;
}

function isLocalModelServer(value: unknown): value is LocalModelServer {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== "string" || !SERVER_KINDS.has(value.kind as LocalModelServerKind)) return false;
  if (typeof value.baseUrl !== "string" || !normalizeModelBaseUrl(value.baseUrl)) return false;
  if (!Array.isArray(value.models) || value.models.length > 256) return false;
  return value.models.every(isLocalModelDescriptor);
}

export function parseLocalModelsPayload(raw: unknown): LocalModelsPayload | null {
  if (!isRecord(raw) || raw.kind !== "local-models") return null;
  if (!Array.isArray(raw.servers) || raw.servers.length > 16) return null;
  const servers: LocalModelServer[] = [];
  for (const row of raw.servers) {
    if (!isLocalModelServer(row)) continue;
    const baseUrl = normalizeModelBaseUrl(row.baseUrl);
    if (!baseUrl) continue;
    const seen = new Set<string>();
    const models: LocalModelDescriptor[] = [];
    for (const model of row.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({ id: model.id, name: model.name });
    }
    servers.push({ kind: row.kind, baseUrl, models });
  }
  if (wireContainsForbiddenMaterial(servers)) return null;
  return { kind: "local-models", servers };
}

export function parseFleetChatMessages(raw: unknown): FleetChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > FLEET_CHAT_MAX_MESSAGES) return null;
  const messages: FleetChatMessage[] = [];
  for (const row of raw) {
    if (!isRecord(row)) return null;
    if (typeof row.role !== "string" || !MESSAGE_ROLES.has(row.role as FleetChatMessage["role"])) return null;
    if (typeof row.content !== "string" || row.content.length > FLEET_CHAT_MAX_MESSAGE_CHARS) return null;
    messages.push({ role: row.role as FleetChatMessage["role"], content: row.content });
  }
  return messages;
}

export function parseFleetChatJobPayload(raw: unknown): FleetChatJobPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.baseUrl !== "string") return null;
  const baseUrl = normalizeModelBaseUrl(raw.baseUrl);
  if (!baseUrl) return null;
  if (typeof raw.model !== "string" || raw.model.length === 0 || raw.model.length > 200) return null;
  if (typeof raw.threadId !== "string" || raw.threadId.length === 0 || raw.threadId.length > 128) return null;
  if (typeof raw.turnId !== "string" || raw.turnId.length === 0 || raw.turnId.length > 128) return null;
  const messages = parseFleetChatMessages(raw.messages);
  if (!messages) return null;
  return { baseUrl, model: raw.model, messages, threadId: raw.threadId, turnId: raw.turnId };
}

export function encodeFleetChatResult(result: FleetChatResultWire): string {
  if (result.kind !== "fleet-chat") throw new Error("refusing to encode unknown fleet chat kind");
  if (typeof result.body.ok !== "boolean" || typeof result.body.turnId !== "string") {
    throw new Error("fleet chat body is invalid");
  }
  if (!Array.isArray(result.body.events)) throw new Error("fleet chat body is invalid");
  if (wireContainsForbiddenMaterial(result)) {
    throw new Error("refusing to encode forbidden fleet chat material");
  }
  const json = JSON.stringify(result);
  if (json.length > 512_000) throw new Error("fleet chat result too large");
  return json;
}

export function parseFleetChatResult(stdout: string): FleetChatResultWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("bridge fleet chat job returned invalid JSON");
  }
  if (!isRecord(parsed) || parsed.kind !== "fleet-chat" || !isRecord(parsed.body)) {
    throw new Error("bridge fleet chat job returned unknown kind");
  }
  const body = parsed.body;
  if (typeof body.ok !== "boolean" || typeof body.turnId !== "string" || !Array.isArray(body.events)) {
    throw new Error("bridge fleet chat body is invalid");
  }
  if (wireContainsForbiddenMaterial(parsed)) {
    throw new Error("bridge fleet chat job leaked forbidden material");
  }
  return {
    kind: "fleet-chat",
    body: {
      ok: body.ok,
      turnId: body.turnId,
      events: body.events as ScrubbedRuntimeEvent[],
    },
  };
}

export function scrubFleetChatEvents(events: RuntimeEvent[]): ScrubbedRuntimeEvent[] {
  return scrubRuntimeEvents(events).slice(0, FLEET_CHAT_MAX_EVENTS);
}
