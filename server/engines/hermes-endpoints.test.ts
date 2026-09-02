import { describe, expect, it } from "vitest";

import {
  hermesEndpointId,
  hermesEndpointLabel,
  hermesEndpointComputerName,
  projectHermesEndpointAuthStatus,
  type HermesEndpointAuthStatus,
  type HermesEndpointPlacement,
} from "./hermes-endpoints.ts";

describe("Hermes endpoint identity", () => {
  it("treats each computer and profile pair as a distinct endpoint", () => {
    const localDefault: HermesEndpointPlacement = { kind: "local", profile: "default" };
    const localWork: HermesEndpointPlacement = { kind: "local", profile: "work" };
    const miniDefault: HermesEndpointPlacement = { kind: "bridge", bridge: "Mac mini", profile: "default" };
    const studioDefault: HermesEndpointPlacement = { kind: "bridge", bridge: "Studio", profile: "default" };

    expect(hermesEndpointId(localDefault)).not.toBe(hermesEndpointId(localWork));
    expect(hermesEndpointId(localDefault)).not.toBe(hermesEndpointId(miniDefault));
    expect(hermesEndpointId(miniDefault)).not.toBe(hermesEndpointId(studioDefault));
    expect(hermesEndpointId(miniDefault)).toBe(hermesEndpointId({
      kind: "bridge",
      bridge: "mac mini",
      profile: "default",
    }));
  });

  it("labels endpoints with a friendly machine name and never a bridge id", () => {
    expect(hermesEndpointComputerName(
      { kind: "local", profile: "default" },
      "Vincent’s Mac",
    )).toBe("Vincent’s Mac");
    expect(hermesEndpointComputerName({ kind: "local", profile: "default" })).toBe("This computer");
    expect(hermesEndpointComputerName({
      kind: "bridge",
      bridge: "Mac mini",
      profile: "default",
    })).toBe("Mac mini");
    expect(hermesEndpointLabel("Mac mini", "default")).toBe("Mac mini · Hermes");
    expect(hermesEndpointLabel("Mac mini", "work")).toBe("Mac mini · work");
    expect(hermesEndpointId({
      kind: "bridge",
      bridge: "Mac mini",
      profile: "default",
    })).not.toMatch(/bridgeId|brg_|[0-9a-f]{8}-[0-9a-f-]{8,}/i);
  });
});

describe("Hermes endpoint auth status", () => {
  const statuses = (status: HermesEndpointAuthStatus) => status;

  it("maps reachable signed-in Hermes to Connected", () => {
    expect(projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: true,
      providerConfigured: true,
    })).toBe(statuses("connected"));
  });

  it("maps a reachable gateway without provider credentials to Sign-in required", () => {
    expect(projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: true,
      providerConfigured: false,
    })).toBe("signInRequired");
    expect(projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: true,
      providerConfigured: true,
      reason: "invalid_credentials",
    })).toBe("signInRequired");
  });

  it("maps an unreachable computer to Offline", () => {
    expect(projectHermesEndpointAuthStatus({
      computerOnline: false,
      hermesReachable: false,
      providerConfigured: false,
    })).toBe("offline");
  });

  it("maps a reachable computer whose Hermes is missing or broken to Unavailable", () => {
    expect(projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: false,
      providerConfigured: false,
      reason: "missing_cli",
    })).toBe("unavailable");
    expect(projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: false,
      providerConfigured: false,
      reason: "gateway_unavailable",
    })).toBe("unavailable");
    expect(projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: false,
      providerConfigured: false,
      reason: "malformed_response",
    })).toBe("unavailable");
  });

  it("never includes secrets or paths in status values", () => {
    const status = projectHermesEndpointAuthStatus({
      computerOnline: true,
      hermesReachable: true,
      providerConfigured: false,
    });
    expect(JSON.stringify(status)).not.toMatch(/sk-|Bearer |HERMES_HOME|\/Users\/|token|secret/i);
  });
});
