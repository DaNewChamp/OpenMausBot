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

export function wireContainsForbiddenMaterial(value: unknown): boolean {
  const json = JSON.stringify(value).toLowerCase();
  return FORBIDDEN_WIRE_SUBSTRINGS.some((needle) => json.includes(needle.toLowerCase()));
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
  return scrubbed as ScrubbedRuntimeEvent;
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
  if (wireContainsForbiddenMaterial(result)) {
    throw new Error("refusing to encode forbidden Hermes bridge material");
  }
  const json = JSON.stringify(result);
  if (json.length > 512_000) throw new Error("Hermes bridge result too large");
  return json;
}

export function parseHermesBridgeResult(stdout: string): HermesBridgeResultWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("bridge hermes job returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("bridge hermes job returned invalid envelope");
  }
  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (
    kind !== "hermes-discover"
    && kind !== "hermes-ensure-canonical"
    && kind !== "hermes-send"
    && kind !== "hermes-interrupt"
  ) {
    throw new Error("bridge hermes job returned unknown kind");
  }
  if (!record.body || typeof record.body !== "object" || Array.isArray(record.body)) {
    throw new Error("bridge hermes job missing body");
  }
  if (wireContainsForbiddenMaterial(parsed)) {
    throw new Error("bridge hermes job leaked forbidden material");
  }
  return parsed as HermesBridgeResultWire;
}
