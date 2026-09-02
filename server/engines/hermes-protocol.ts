import { HermesEngineError } from "./contracts.ts";

/** JSON-RPC 2.0 method-not-found — Hermes 0.10 gateways omit Wave 2 profile RPCs. */
export const HERMES_JSONRPC_METHOD_NOT_FOUND = -32601;

export type HermesGatewayProtocol = "modern" | "legacy";

export interface HermesSetupStatus {
  providerConfigured: boolean;
}

export function hermesRpcCode(error: unknown): number | undefined {
  if (!(error instanceof HermesEngineError)) return undefined;
  return error.rpcCode;
}

export function isHermesMethodNotFound(error: unknown): boolean {
  return hermesRpcCode(error) === HERMES_JSONRPC_METHOD_NOT_FOUND;
}

export function normalizeSetupStatus(payload: unknown): HermesSetupStatus | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.provider_configured !== "boolean") return undefined;
  return { providerConfigured: record.provider_configured };
}

/** Synthetic single-profile roster for Hermes 0.10 (no profiles.list). */
export function legacyDefaultProfileRow(providerConfigured: boolean): Record<string, unknown> {
  return {
    name: "default",
    is_default: true,
    display_name: "Hermes",
    description: "",
    available: providerConfigured,
  };
}

export function sessionListParams(protocol: HermesGatewayProtocol, profile: string): Record<string, unknown> {
  if (protocol === "legacy") return { limit: 200 };
  return { profile, title: "Bot Chat", include_hidden: true, limit: 200 };
}

export function sessionResumeParams(
  protocol: HermesGatewayProtocol,
  sessionId: string,
  profile: string,
): Record<string, unknown> {
  if (protocol === "legacy") return { session_id: sessionId, cols: 80 };
  return { profile, session_id: sessionId };
}
