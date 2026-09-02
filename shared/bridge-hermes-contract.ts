import type { RuntimeEvent } from "../server/contracts.ts";
import type {
  HermesCapabilityFlags,
  HermesDiscovery,
  HermesFailureCode,
  HermesRosterRow,
} from "../server/engines/contracts.ts";

export const HERMES_BRIDGE_BINDING_VERSION = 1 as const;
export const HERMES_BRIDGE_MAX_EVENTS = 64;
export const HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH = 8_192;
export const HERMES_BRIDGE_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const HERMES_BRIDGE_MAX_PROFILE_LENGTH = 64;

export type HermesBridgeJobKind =
  | "hermes-discover"
  | "hermes-ensure-canonical"
  | "hermes-send"
  | "hermes-interrupt";

export interface HermesBridgeDiscoverPayload {}

export interface HermesBridgeEnsureCanonicalPayload {
  profile: string;
}

export interface HermesBridgeSendPayload {
  profile: string;
  text: string;
  threadId: string;
  turnId: string;
  model?: string;
}

export interface HermesBridgeInterruptPayload {
  profile: string;
  turnId?: string;
}

export type HermesBridgeJobPayload =
  | HermesBridgeDiscoverPayload
  | HermesBridgeEnsureCanonicalPayload
  | HermesBridgeSendPayload
  | HermesBridgeInterruptPayload;

export interface HermesBridgeBinding {
  bridgeId: string;
  profile: string;
  bindingVersion: typeof HERMES_BRIDGE_BINDING_VERSION;
}

export interface HermesBridgeDiscoveryWire {
  state: "available" | "unavailable";
  reason?: HermesFailureCode;
  version?: string;
  authenticated?: boolean;
  capabilities: HermesCapabilityFlags;
  profiles: HermesRosterRow[];
}

export interface HermesBridgeEnsureCanonicalWire {
  state: "present" | "absent" | "unknown";
  reason?: HermesFailureCode;
  adopted?: boolean;
}

export interface HermesBridgeSendWire {
  ok: boolean;
  reason?: HermesFailureCode;
  turnId: string;
  events: ScrubbedRuntimeEvent[];
}

export interface HermesBridgeInterruptWire {
  ok: boolean;
  reason?: HermesFailureCode;
}

export type HermesBridgeResultWire =
  | { kind: "hermes-discover"; body: HermesBridgeDiscoveryWire }
  | { kind: "hermes-ensure-canonical"; body: HermesBridgeEnsureCanonicalWire }
  | { kind: "hermes-send"; body: HermesBridgeSendWire }
  | { kind: "hermes-interrupt"; body: HermesBridgeInterruptWire };

export type ScrubbedRuntimeEvent = Pick<
  RuntimeEvent,
  "eventId" | "provider" | "threadId" | "turnId" | "createdAt" | "type"
> &
  Record<string, unknown>;

const FORBIDDEN_WIRE_SUBSTRINGS = [
  "HERMES_HOME",
  "jsonrpc",
  "session_id",
  "sessionId",
  "rootSessionId",
  "resolvedSessionId",
  "stderr",
  "Brain",
  "OPENMAUSBOT",
  "V_BOT",
  "/Users/",
  "/home/",
  "/private/",
  "/opt/",
  "Bearer ",
  "sk-",
  "chmp_",
] as const;

const ALLOWED_EVENT_TYPES = new Set([
  "turn.started",
  "turn.completed",
  "turn.retrying",
  "content.delta",
  "item.started",
  "item.updated",
  "item.completed",
  "runtime.error",
  "session.started",
  "session.exited",
]);

const ALLOWED_EVENT_KEYS = new Set([
  "eventId",
  "provider",
  "threadId",
  "turnId",
  "createdAt",
  "type",
  "ok",
  "stopReason",
  "usage",
  "streamKind",
  "delta",
  "itemType",
  "title",
  "text",
  "message",
  "setup",
  "attempt",
  "delayMs",
  "reason",
  "model",
]);

export function validHermesBridgeProfile(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > HERMES_BRIDGE_MAX_PROFILE_LENGTH) {
    return undefined;
  }
  if (!HERMES_BRIDGE_PROFILE_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

export function wireContainsForbiddenMaterial(value: unknown): boolean {
  const json = JSON.stringify(value).toLowerCase();
  return FORBIDDEN_WIRE_SUBSTRINGS.some((needle) => json.includes(needle.toLowerCase()));
}

function fitEventJsonLength(scrubbed: Record<string, unknown>): Record<string, unknown> | null {
  if (JSON.stringify(scrubbed).length <= HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH) return scrubbed;
  const contentKeys = ["delta", "text", "message", "title"] as const;
  for (const key of contentKeys) {
    const value = scrubbed[key];
    if (typeof value === "string" && value.length > 256) {
      scrubbed[key] = value.slice(0, 256);
    }
  }
  if (JSON.stringify(scrubbed).length <= HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH) return scrubbed;
  for (const key of contentKeys) {
    delete scrubbed[key];
  }
  if (JSON.stringify(scrubbed).length > HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH) return null;
  return scrubbed;
}

export function scrubRuntimeEvent(event: RuntimeEvent): ScrubbedRuntimeEvent | null {
  if (!ALLOWED_EVENT_TYPES.has(event.type)) return null;
  const scrubbed: Record<string, unknown> = {
    eventId: event.eventId,
    provider: event.provider,
    threadId: event.threadId,
    turnId: event.turnId,
    createdAt: event.createdAt,
    type: event.type,
  };
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_EVENT_KEYS.has(key)) continue;
    if (key === "raw") continue;
    if (value === undefined) continue;
    scrubbed[key] = value;
  }
  if (wireContainsForbiddenMaterial(scrubbed)) return null;
  const sized = fitEventJsonLength(scrubbed);
  if (!sized) return null;
  return sized as ScrubbedRuntimeEvent;
}

export function scrubRuntimeEvents(events: RuntimeEvent[]): ScrubbedRuntimeEvent[] {
  const output: ScrubbedRuntimeEvent[] = [];
  for (const event of events) {
    const scrubbed = scrubRuntimeEvent(event);
    if (scrubbed) output.push(scrubbed);
    if (output.length >= HERMES_BRIDGE_MAX_EVENTS) break;
  }
  return output;
}

export function projectHermesDiscoveryWire(discovery: HermesDiscovery): HermesBridgeDiscoveryWire {
  const wire: HermesBridgeDiscoveryWire = {
    state: discovery.state,
    ...(discovery.reason ? { reason: discovery.reason } : {}),
    ...(discovery.version ? { version: discovery.version } : {}),
    ...(discovery.authenticated === undefined ? {} : { authenticated: discovery.authenticated }),
    capabilities: { ...discovery.capabilities },
    profiles: discovery.profiles.map((row) => ({ ...row })),
  };
  if (wireContainsForbiddenMaterial(wire)) {
    return {
      state: "unavailable",
      reason: "malformed_response",
      capabilities: discovery.capabilities,
      profiles: [],
    };
  }
  return wire;
}

export function encodeHermesBridgeResult(result: HermesBridgeResultWire): string {
  validateHermesBridgeResultWire(result);
  if (wireContainsForbiddenMaterial(result)) {
    throw new Error("refusing to encode forbidden Hermes bridge material");
  }
  const json = JSON.stringify(result);
  if (json.length > 512_000) throw new Error("Hermes bridge result too large");
  return json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function validateCapabilityFlags(value: unknown): value is HermesCapabilityFlags {
  if (!isRecord(value)) return false;
  return HERMES_CAPABILITY_KEYS.every((key) => isBoolean(value[key]));
}

const HERMES_CAPABILITY_KEYS = [
  "roster",
  "canonicalChat",
  "send",
  "finalResponse",
  "events",
  "stop",
  "routinesRead",
  "messageAgent",
  "groups",
  "crossMachine",
  "queueing",
  "steer",
  "attachments",
] as const;

function validateScrubbedRuntimeEvent(value: unknown): value is ScrubbedRuntimeEvent {
  if (!isRecord(value)) return false;
  if (!isString(value.eventId) || !isString(value.provider) || !isString(value.threadId)) return false;
  if (!isString(value.turnId) || !isString(value.createdAt) || !isString(value.type)) return false;
  if (!ALLOWED_EVENT_TYPES.has(value.type)) return false;
  if (JSON.stringify(value).length > HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH) return false;
  for (const key of Object.keys(value)) {
    if (!ALLOWED_EVENT_KEYS.has(key)) return false;
  }
  return true;
}

function validateDiscoveryBody(body: Record<string, unknown>): boolean {
  if (body.state !== "available" && body.state !== "unavailable") return false;
  if (!validateCapabilityFlags(body.capabilities)) return false;
  if (!Array.isArray(body.profiles)) return false;
  return body.profiles.every((row) => {
    if (!isRecord(row)) return false;
    return isString(row.profile)
      && isString(row.handle)
      && isString(row.displayName)
      && isString(row.description)
      && isString(row.canonicalChat)
      && isString(row.availability);
  });
}

function validateEnsureCanonicalBody(body: Record<string, unknown>): boolean {
  return body.state === "present" || body.state === "absent" || body.state === "unknown";
}

function validateSendBody(body: Record<string, unknown>): boolean {
  if (!isBoolean(body.ok) || !isString(body.turnId) || !Array.isArray(body.events)) return false;
  return body.events.every((event) => validateScrubbedRuntimeEvent(event));
}

function validateInterruptBody(body: Record<string, unknown>): boolean {
  return isBoolean(body.ok);
}

export function validateHermesBridgeResultWire(value: unknown): HermesBridgeResultWire {
  if (!isRecord(value)) throw new Error("bridge hermes job returned invalid envelope");
  const kind = value.kind;
  if (
    kind !== "hermes-discover"
    && kind !== "hermes-ensure-canonical"
    && kind !== "hermes-send"
    && kind !== "hermes-interrupt"
  ) {
    throw new Error("bridge hermes job returned unknown kind");
  }
  if (!isRecord(value.body)) throw new Error("bridge hermes job missing body");
  const body = value.body;
  if (kind === "hermes-discover" && !validateDiscoveryBody(body)) {
    throw new Error("bridge hermes discovery body is invalid");
  }
  if (kind === "hermes-ensure-canonical" && !validateEnsureCanonicalBody(body)) {
    throw new Error("bridge hermes ensure-canonical body is invalid");
  }
  if (kind === "hermes-send" && !validateSendBody(body)) {
    throw new Error("bridge hermes send body is invalid");
  }
  if (kind === "hermes-interrupt" && !validateInterruptBody(body)) {
    throw new Error("bridge hermes interrupt body is invalid");
  }
  if (wireContainsForbiddenMaterial(value)) {
    throw new Error("bridge hermes job leaked forbidden material");
  }
  return value as HermesBridgeResultWire;
}

export function parseHermesBridgeResult(stdout: string): HermesBridgeResultWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("bridge hermes job returned invalid JSON");
  }
  return validateHermesBridgeResultWire(parsed);
}
