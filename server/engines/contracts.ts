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
  "adoptMint",
  "approvals",
  "exclusiveSubmit",
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
  adoptMint: boolean;
  approvals: boolean;
  exclusiveSubmit: boolean;
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
  | "groups_unavailable"
  | "upstream_error";

const DEFAULT_FAILURE_MESSAGES = {
  missing_cli: "Hermes is not installed",
  invalid_credentials: "Hermes credentials are unavailable",
  gateway_unavailable: "Hermes gateway is unavailable",
  state_unavailable: "Hermes state is unavailable",
  malformed_response: "Hermes returned an invalid response",
  timeout: "Hermes request timed out",
  profile_unavailable: "Hermes profile is unavailable",
  groups_unavailable: "Hermes does not support groups",
  upstream_error: "Hermes request failed",
} as const satisfies Record<HermesFailureCode, string>;

export class HermesEngineError extends Error {
  readonly code: HermesFailureCode;
  readonly rpcCode?: number;

  constructor(code: HermesFailureCode, detail?: unknown) {
    // Public diagnostics are deliberately selected only from this fixed map.
    // Callers receive no escape hatch for paths, argv, stderr, provider
    // payloads, or query text to reach the error message.
    super(DEFAULT_FAILURE_MESSAGES[code]);
    Object.defineProperty(this, "name", { value: "HermesEngineError", enumerable: false });
    this.code = code;
    Object.defineProperty(this, "code", { value: code, enumerable: true, writable: false, configurable: false });
    // Type stripping on Node 24 emits the optional class field as an enumerable
    // `undefined` own property. Always replace it so public JSON/key enumeration
    // stays `{ code }` even when no numeric RPC code was captured.
    const rpcCode = typeof detail === "number" && Number.isSafeInteger(detail) ? detail : undefined;
    Object.defineProperty(this, "rpcCode", { value: rpcCode, enumerable: false, writable: false, configurable: false });
  }
}

export type HermesCanonicalLookup =
  | { state: "present"; chat: HermesCanonicalChat }
  | { state: "absent" }
  | {
      state: "unknown";
      code:
        | "missing_cli"
        | "invalid_credentials"
        | "gateway_unavailable"
        | "state_unavailable"
        | "malformed_response"
        | "timeout"
        | "profile_unavailable";
      message: string;
    };
