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

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u0080-\u009f]/g;

interface RecordLike {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(CONTROL_CHARACTERS, " ").trim();
  return text.length > 0 ? text.slice(0, maxLength) : undefined;
}

function validProfileSlug(value: unknown): string | undefined {
  const text = boundedText(value, HERMES_PROFILE_MAX_LENGTH);
  if (!text || text.length > HERMES_PROFILE_MAX_LENGTH || !PROFILE_PATTERN.test(text)) return undefined;
  return text.toLowerCase();
}

function validSessionId(value: unknown): string | undefined {
  const text = boundedText(value, HERMES_SESSION_ID_MAX_LENGTH);
  if (!text || text.length > HERMES_SESSION_ID_MAX_LENGTH) return undefined;
  return text;
}

function profileRowsPayload(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.profiles)) return payload.profiles;
  return undefined;
}

function canonicalState(raw: RecordLike): HermesRosterRow["canonicalChat"] {
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
  if (raw.name !== undefined && typeof raw.name !== "string") return true;
  if (raw.display_name !== undefined && typeof raw.display_name !== "string") return true;
  if (raw.description !== undefined && typeof raw.description !== "string") return true;
  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string") return true;
  if (raw.provider !== undefined && raw.provider !== null && typeof raw.provider !== "string") return true;
  return false;
}

export function normalizeProfileRows(payload: unknown): HermesRosterRow[] {
  const rows = profileRowsPayload(payload);
  if (!rows) return [];

  const normalized = rows.map((value): HermesRosterRow => {
    if (!isRecord(value)) {
      return {
        profile: "",
        handle: "",
        displayName: "Unavailable profile",
        description: "",
        canonicalChat: "unknown",
        availability: "unavailable",
      };
    }

    const originalName = boundedText(value.name, HERMES_PROFILE_MAX_LENGTH);
    const profile = validProfileSlug(value.name);
    const isDefault = value.is_default === true || originalName?.toLowerCase() === "default";
    const handle = profile && isDefault ? "hermes" : profile ?? "";
    const displayName =
      boundedText(value.display_name, HERMES_DISPLAY_NAME_MAX_LENGTH) ??
      (isDefault ? "Hermes" : profile || "Unavailable profile");
    const description = boundedText(value.description, HERMES_DESCRIPTION_MAX_LENGTH) ?? "";
    const model = boundedText(value.model, HERMES_MODEL_MAX_LENGTH);
    const provider = boundedText(value.provider, HERMES_PROVIDER_MAX_LENGTH);

    return {
      profile: profile ?? "",
      handle,
      displayName,
      description,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      canonicalChat: canonicalState(value),
      availability:
        profile && handle && !isMalformedProfileRow(value) && value.error === undefined && value.available !== false
          ? "available"
          : "unavailable",
    };
  });

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

  return normalized
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const byProfile = left.row.profile.localeCompare(right.row.profile);
      if (byProfile !== 0) return byProfile;
      const byHandle = left.row.handle.localeCompare(right.row.handle);
      if (byHandle !== 0) return byHandle;
      const byDisplay = left.row.displayName.localeCompare(right.row.displayName);
      return byDisplay !== 0 ? byDisplay : left.index - right.index;
    })
    .map(({ row }) => row);
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

export function normalizeCanonicalLookup(payload: unknown, profile: string): HermesCanonicalLookup {
  const normalizedProfile = validProfileSlug(profile);
  if (!normalizedProfile || !isRecord(payload)) return unknownCanonical("malformed_response");
  if (Object.prototype.hasOwnProperty.call(payload, "error") || payload.ok === false) {
    return unknownCanonical("state_unavailable");
  }
  if (!Array.isArray(payload.sessions)) return unknownCanonical("malformed_response");

  const eligible: HermesCanonicalChat[] = [];
  for (const value of payload.sessions) {
    if (!isRecord(value)) return unknownCanonical("malformed_response");
    if (typeof value.title !== "string") return unknownCanonical("malformed_response");
    if (value.title !== "Bot Chat") continue;

    const source = typeof value.source === "string" ? value.source.toLowerCase() : "";
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
