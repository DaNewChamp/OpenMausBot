export type HermesCapabilityState = "available" | "unavailable";
export type HermesCanonicalState = "present" | "absent" | "unknown";

export const HERMES_CAPABILITY_KEYS = [
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

export interface HermesCapabilityFlags {
  roster: boolean;
  canonicalChat: boolean;
  send: boolean;
  finalResponse: boolean;
  events: boolean;
  stop: boolean;
  routinesRead: boolean;
  messageAgent: boolean;
  groups: boolean;
  crossMachine: boolean;
  queueing: boolean;
  steer: boolean;
  attachments: boolean;
}

export interface HermesBotBinding {
  adapter: "hermesBot";
  profile: string;
  canonicalTitle: "Bot Chat";
  bindingVersion: 1;
}

export interface HermesCanonicalChat {
  profile: string;
  title: "Bot Chat";
  rootSessionId: string;
  resolvedSessionId: string;
  messageCount: number;
  preview?: string;
}

export interface HermesRosterRow {
  profile: string;
  handle: string;
  displayName: string;
  description: string;
  model?: string;
  provider?: string;
  canonicalChat: HermesCanonicalState;
  availability: HermesCapabilityState;
}

export interface HermesDiscovery {
  state: HermesCapabilityState;
  reason?:
    | "missing_cli"
    | "invalid_credentials"
    | "gateway_unavailable"
    | "state_unavailable"
    | "malformed_response"
    | "timeout";
  version?: string;
  authenticated?: boolean;
  capabilities: HermesCapabilityFlags;
  profiles: HermesRosterRow[];
}

export type HermesFailureCode =
  | "missing_cli"
  | "invalid_credentials"
  | "gateway_unavailable"
  | "state_unavailable"
  | "malformed_response"
  | "timeout"
  | "profile_unavailable"
  | "upstream_error";

const DEFAULT_FAILURE_MESSAGES: Record<HermesFailureCode, string> = {
  missing_cli: "Hermes is not installed",
  invalid_credentials: "Hermes credentials are unavailable",
  gateway_unavailable: "Hermes gateway is unavailable",
  state_unavailable: "Hermes state is unavailable",
  malformed_response: "Hermes returned an invalid response",
  timeout: "Hermes request timed out",
  profile_unavailable: "Hermes profile is unavailable",
  upstream_error: "Hermes request failed",
};

function safeFailureMessage(code: HermesFailureCode, message: unknown): string {
  if (typeof message !== "string") return DEFAULT_FAILURE_MESSAGES[code];
  const normalized = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 160 ||
    /[/\\]|HERMES_HOME|state(?:\.db)?|argv|stderr|provider|token|secret|password|prompt|query/i.test(normalized)
  ) {
    return DEFAULT_FAILURE_MESSAGES[code];
  }
  return normalized;
}

export class HermesEngineError extends Error {
  readonly code: HermesFailureCode;

  constructor(code: HermesFailureCode, message?: string) {
    super(safeFailureMessage(code, message));
    Object.defineProperty(this, "name", { value: "HermesEngineError", enumerable: false });
    this.code = code;
    Object.defineProperty(this, "code", { value: code, enumerable: true, writable: false, configurable: false });
  }
}

export type HermesCanonicalLookup =
  | { state: "present"; chat: HermesCanonicalChat }
  | { state: "absent" }
  | { state: "unknown"; code: "state_unavailable" | "malformed_response"; message: string };
