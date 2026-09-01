import {
  HERMES_CAPABILITY_KEYS,
  HermesEngineError,
  type HermesCanonicalChat,
  type HermesCanonicalLookup,
  type HermesCapabilityFlags,
  type HermesRosterRow,
} from "./contracts.ts";

export const HERMES_PROFILE_MAX_LENGTH = 64;
export const HERMES_DISPLAY_NAME_MAX_LENGTH = 120;
export const HERMES_DESCRIPTION_MAX_LENGTH = 500;
export const HERMES_MODEL_MAX_LENGTH = 200;
export const HERMES_PROVIDER_MAX_LENGTH = 120;
export const HERMES_PREVIEW_MAX_LENGTH = 500;
export const HERMES_SESSION_ID_MAX_LENGTH = 256;
export const HERMES_SESSION_LIST_LIMIT = 200;

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u0080-\u009f]/;
const WHITESPACE = /\s/;

interface RecordLike {
  [key: string]: unknown;
}

function hasOwn(record: RecordLike, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, " ").trim();
  return text.length > 0 ? text.slice(0, maxLength) : undefined;
}

function exactText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  if (value.trim() !== value || CONTROL_CHARACTERS.test(value) || WHITESPACE.test(value)) return undefined;
  return value;
}

function validProfileSlug(value: unknown): string | undefined {
  const text = exactText(value, HERMES_PROFILE_MAX_LENGTH);
  if (!text || !PROFILE_PATTERN.test(text)) return undefined;
  return text.toLowerCase();
}

function validSessionId(value: unknown): string | undefined {
  return exactText(value, HERMES_SESSION_ID_MAX_LENGTH);
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

const ENVELOPE_SUCCESS_STATES = new Set(["ok", "success", "available", "ready"]);

function envelopeMarkersUnavailable(payload: RecordLike): boolean {
  for (const key of ["ok", "success", "failed", "available"] as const) {
    if (!hasOwn(payload, key)) continue;
    if (typeof payload[key] !== "boolean") return true;
    const successful = key === "failed" ? payload[key] === false : payload[key] === true;
    if (!successful) return true;
  }

  for (const key of ["error", "failure"] as const) {
    if (!hasOwn(payload, key)) continue;
    const value = payload[key];
    if (value === null) continue;
    if (typeof value === "string" || isRecord(value)) return true;
    return true;
  }

  for (const key of ["status", "state"] as const) {
    if (!hasOwn(payload, key)) continue;
    if (typeof payload[key] !== "string") return true;
    if (!ENVELOPE_SUCCESS_STATES.has(payload[key].toLowerCase())) return true;
  }
  return false;
}

function profileRowsPayload(payload: unknown): { rows: unknown[]; malformed: boolean; unavailable: boolean } {
  if (Array.isArray(payload)) return { rows: payload, malformed: false, unavailable: false };
  if (!isRecord(payload)) {
    return { rows: [], malformed: true, unavailable: false };
  }
  if (envelopeMarkersUnavailable(payload)) return { rows: [], malformed: false, unavailable: true };
  if (!hasOwn(payload, "profiles")) {
    return { rows: [], malformed: true, unavailable: false };
  }
  return Array.isArray(payload.profiles)
    ? { rows: payload.profiles, malformed: false, unavailable: false }
    : { rows: [], malformed: true, unavailable: false };
}

function canonicalState(raw: RecordLike): HermesRosterRow["canonicalChat"] {
  if (hasOwn(raw, "canonical_session") && hasOwn(raw, "canonical_chat")) {
    return "unknown";
  }
  const value = raw.canonical_session ?? raw.canonical_chat;
  if (value === undefined || value === null || value === false) return "absent";
  if (typeof value === "string") return value === "present" ? "present" : "unknown";
  if (!isRecord(value)) return "unknown";
  if (value.state === "absent") return "absent";
  if (value.state === "unknown") return "unknown";
  if (value.id === undefined) return "unknown";
  return validSessionId(value.id) ? "present" : "unknown";
}

function isMalformedProfileRow(raw: RecordLike): boolean {
  for (const key of ["name", "display_name", "description"] as const) {
    if (hasOwn(raw, key) && typeof raw[key] !== "string") return true;
  }
  for (const key of ["model", "provider"] as const) {
    if (hasOwn(raw, key) && raw[key] !== null && typeof raw[key] !== "string") return true;
  }
  for (const key of ["is_default", "available"] as const) {
    if (hasOwn(raw, key) && typeof raw[key] !== "boolean") return true;
  }
  if (hasOwn(raw, "error") && raw.error !== null && typeof raw.error !== "string") return true;
  for (const key of ["canonical_session", "canonical_chat"] as const) {
    const value = raw[key];
    if (hasOwn(raw, key) && value !== null && value !== false && typeof value !== "string" && !isRecord(value)) {
      return true;
    }
  }
  return false;
}

function unavailableProfileRow(): HermesRosterRow {
  return {
    profile: "",
    handle: "",
    displayName: "Unavailable profile",
    description: "",
    canonicalChat: "unknown",
    availability: "unavailable",
  };
}

function normalizeProfileRow(value: unknown): HermesRosterRow {
  if (!isRecord(value)) return unavailableProfileRow();

  const profile = validProfileSlug(value.name);
  const isDefault = value.is_default === true || profile === "default";
  const handle = profile && isDefault ? "hermes" : profile ?? "";
  const displayName = boundedText(value.display_name, HERMES_DISPLAY_NAME_MAX_LENGTH)
    ?? (isDefault ? "Hermes" : profile || "Unavailable profile");
  const description = boundedText(value.description, HERMES_DESCRIPTION_MAX_LENGTH) ?? "";
  const model = boundedText(value.model, HERMES_MODEL_MAX_LENGTH);
  const provider = boundedText(value.provider, HERMES_PROVIDER_MAX_LENGTH);
  const malformed = isMalformedProfileRow(value);

  return {
    profile: profile ?? "",
    handle,
    displayName,
    description,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    canonicalChat: canonicalState(value),
    availability:
      profile && handle && !malformed && !hasOwn(value, "error") && value.available !== false
        ? "available"
        : "unavailable",
  };
}

function sortProfileRows(rows: HermesRosterRow[]): HermesRosterRow[] {
  return rows
    .slice()
    .sort((left, right) => {
      for (const [leftValue, rightValue] of [
        [left.profile, right.profile],
        [left.handle, right.handle],
        [left.displayName, right.displayName],
        [left.description, right.description],
        [left.model ?? "", right.model ?? ""],
        [left.provider ?? "", right.provider ?? ""],
        [left.canonicalChat, right.canonicalChat],
        [left.availability, right.availability],
      ] as const) {
        const comparison = compareCodePoints(leftValue, rightValue);
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
}

export type HermesProfileRowsResult =
  | { state: "available"; profiles: HermesRosterRow[] }
  | { state: "unknown"; code: "state_unavailable" | "malformed_response"; message: string; profiles: HermesRosterRow[] };

export function normalizeProfileRowsResult(payload: unknown): HermesProfileRowsResult {
  const { rows, malformed, unavailable } = profileRowsPayload(payload);
  if (unavailable) {
    const error = new HermesEngineError("state_unavailable");
    return { state: "unknown", code: "state_unavailable", message: error.message, profiles: [] };
  }
  if (malformed) {
    const error = new HermesEngineError("malformed_response");
    return { state: "unknown", code: "malformed_response", message: error.message, profiles: [] };
  }

  const normalized = rows.map(normalizeProfileRow);
  const duplicateProfiles = new Set<string>();
  const duplicateHandles = new Set<string>();
  for (const field of ["profile", "handle"] as const) {
    const counts = new Map<string, number>();
    for (const row of normalized) {
      if (!row[field]) continue;
      const key = row[field].toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    if (field === "profile") duplicates.forEach((key) => duplicateProfiles.add(key));
    else duplicates.forEach((key) => duplicateHandles.add(key));
  }

  for (const row of normalized) {
    if (duplicateProfiles.has(row.profile.toLowerCase()) || duplicateHandles.has(row.handle.toLowerCase())) {
      row.availability = "unavailable";
    }
  }

  return { state: "available", profiles: sortProfileRows(normalized) };
}

/**
 * Keep the original array-shaped helper for callers that only need rows while
 * attaching a non-enumerable state marker so malformed and valid-empty input
 * cannot be confused. New callers should prefer normalizeProfileRowsResult.
 */
export function normalizeProfileRows(payload: unknown): HermesRosterRow[] {
  const result = normalizeProfileRowsResult(payload);
  const rows = result.state === "available" ? result.profiles : [unavailableProfileRow()];
  Object.defineProperty(rows, "state", { value: result.state, enumerable: false });
  Object.defineProperty(rows, "profiles", { value: result.profiles, enumerable: false });
  if (result.state === "unknown") {
    Object.defineProperty(rows, "code", { value: result.code, enumerable: false });
    Object.defineProperty(rows, "message", { value: result.message, enumerable: false });
  }
  return rows;
}

function unknownCanonical(code: "state_unavailable" | "malformed_response"): HermesCanonicalLookup {
  const error = new HermesEngineError(code);
  return { state: "unknown", code, message: error.message };
}

function canonicalSession(value: RecordLike, profile: string): HermesCanonicalChat | undefined {
  const rootSessionId = validSessionId(value.id);
  if (!rootSessionId) return undefined;
  const resolvedSessionId = value.resolved_id === undefined || value.resolved_id === null
    ? rootSessionId
    : validSessionId(value.resolved_id);
  if (!resolvedSessionId) return undefined;

  let messageCount = 0;
  if (value.message_count !== undefined) {
    if (!Number.isSafeInteger(value.message_count) || (value.message_count as number) < 0) return undefined;
    messageCount = value.message_count as number;
  } else if (value.messageCount !== undefined) {
    if (!Number.isSafeInteger(value.messageCount) || (value.messageCount as number) < 0) return undefined;
    messageCount = value.messageCount as number;
  }

  const previewValue = value.preview ?? value.last_message;
  if (previewValue !== undefined && previewValue !== null && typeof previewValue !== "string") return undefined;
  const preview = boundedText(previewValue, HERMES_PREVIEW_MAX_LENGTH);
  return {
    profile,
    title: "Bot Chat",
    rootSessionId,
    resolvedSessionId,
    messageCount,
    ...(preview ? { preview } : {}),
  };
}

function canonicalSource(value: unknown): "kanban" | "tool" | "other" | "malformed" {
  if (value === undefined) return "malformed";
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL_CHARACTERS.test(value) || WHITESPACE.test(value)) {
    return "malformed";
  }
  const source = value.toLowerCase();
  if (source === "kanban") return "kanban";
  if (source === "tool") return "tool";
  return "other";
}

function canonicalRowTypesValid(value: RecordLike): boolean {
  for (const key of ["hidden", "archived", "recoverable", "can_resume"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  if (value.status !== undefined && (typeof value.status !== "string" || value.status.trim() !== value.status || CONTROL_CHARACTERS.test(value.status))) {
    return false;
  }
  return true;
}

export function normalizeCanonicalLookup(payload: unknown, profile: string): HermesCanonicalLookup {
  const normalizedProfile = validProfileSlug(profile);
  if (!normalizedProfile || !isRecord(payload)) return unknownCanonical("malformed_response");
  if (payload.ok !== undefined && typeof payload.ok !== "boolean") return unknownCanonical("malformed_response");
  if (Object.prototype.hasOwnProperty.call(payload, "error") || payload.ok === false) {
    return unknownCanonical("state_unavailable");
  }
  if (payload.limit !== undefined && payload.limit !== HERMES_SESSION_LIST_LIMIT) return unknownCanonical("malformed_response");
  if (payload.include_hidden !== undefined && payload.include_hidden !== true) return unknownCanonical("malformed_response");
  if (!Array.isArray(payload.sessions) || payload.sessions.length > HERMES_SESSION_LIST_LIMIT) {
    return unknownCanonical("malformed_response");
  }

  const eligible: HermesCanonicalChat[] = [];
  for (const value of payload.sessions) {
    if (!isRecord(value) || typeof value.title !== "string") {
      return unknownCanonical("malformed_response");
    }
    if (value.title !== "Bot Chat") continue;
    if (!canonicalRowTypesValid(value)) return unknownCanonical("malformed_response");
    const source = canonicalSource(value.source);
    if (source === "malformed") return unknownCanonical("malformed_response");
    if (source === "kanban" || source === "tool") continue;

    const archived = value.archived === true || value.status === "archived";
    const recoverable = value.recoverable === true || value.can_resume === true;
    if (archived && !recoverable) continue;

    const chat = canonicalSession(value, normalizedProfile);
    if (!chat) return unknownCanonical("malformed_response");
    eligible.push(chat);
  }

  if (eligible.length === 0) return { state: "absent" };
  if (eligible.length > 1) return unknownCanonical("malformed_response");
  return { state: "present", chat: eligible[0] };
}

export interface HermesReadiness {
  roster?: boolean;
  canonicalChat?: boolean;
  send?: boolean;
  finalResponse?: boolean;
  events?: boolean;
  stop?: boolean;
  routinesRead?: boolean;
  messageAgent?: boolean;
  groups?: boolean;
  crossMachine?: boolean;
  queueing?: boolean;
  steer?: boolean;
  attachments?: boolean;
}

export function projectHermesCapabilities(readiness: HermesReadiness): HermesCapabilityFlags {
  const supported = new Set<keyof HermesCapabilityFlags>([
    "roster",
    "canonicalChat",
    "send",
    "finalResponse",
    "events",
    "stop",
  ]);
  const output = {} as HermesCapabilityFlags;
  for (const key of HERMES_CAPABILITY_KEYS) {
    output[key] = supported.has(key) && readiness[key] === true;
  }
  return output;
}
