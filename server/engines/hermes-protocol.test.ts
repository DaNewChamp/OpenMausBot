import { describe, expect, it } from "vitest";

import {
  HERMES_JSONRPC_METHOD_NOT_FOUND,
  isHermesMethodNotFound,
  legacyDefaultProfileRow,
  normalizeSetupStatus,
  sessionListParams,
  sessionResumeParams,
} from "./hermes-protocol.ts";
import { HermesEngineError } from "./contracts.ts";

describe("Hermes gateway protocol helpers", () => {
  it("detects JSON-RPC method-not-found for legacy fallback", () => {
    expect(isHermesMethodNotFound(new HermesEngineError("upstream_error", HERMES_JSONRPC_METHOD_NOT_FOUND))).toBe(true);
    expect(isHermesMethodNotFound(new HermesEngineError("upstream_error"))).toBe(false);
  });

  it("builds legacy session.list and session.resume params", () => {
    expect(sessionListParams("legacy", "default")).toEqual({ limit: 200 });
    expect(sessionListParams("modern", "coder")).toEqual({
      profile: "coder",
      title: "Bot Chat",
      include_hidden: true,
      limit: 200,
    });
    expect(sessionResumeParams("legacy", "session-durable", "default")).toEqual({
      session_id: "session-durable",
      cols: 80,
    });
    expect(sessionResumeParams("modern", "session-tip", "coder")).toEqual({
      profile: "coder",
      session_id: "session-tip",
    });
  });

  it("normalizes setup.status and synthesizes the default legacy profile row", () => {
    expect(normalizeSetupStatus({ provider_configured: true })).toEqual({ providerConfigured: true });
    expect(normalizeSetupStatus({ provider_configured: false })).toEqual({ providerConfigured: false });
    expect(normalizeSetupStatus({ ok: true })).toBeUndefined();
    expect(legacyDefaultProfileRow(true)).toMatchObject({ name: "default", is_default: true, available: true });
  });
});
