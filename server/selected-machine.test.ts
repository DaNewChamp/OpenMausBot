import { describe, expect, it } from "vitest";

import {
  type BridgeCandidate,
  resolveSelectedMachine,
} from "./selected-machine.ts";

describe("selected-machine resolver", () => {
  const now = 1_700_000_000_000;

  it("requires the exact bridge when pinned to Windows even when hub Docker is available", () => {
    const windowsBridge: BridgeCandidate = {
      id: "win-host-1",
      name: "Desktop Windows PC",
      online: true,
      lastSeenAt: now - 1_000,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };

    const resolution = resolveSelectedMachine({
      hostId: "win-host-1",
      bridges: [windowsBridge],
      hubDockerAvailable: true,
      now,
    });

    expect(resolution).toMatchObject({
      kind: "bridge",
      bridgeId: "win-host-1",
    });
  });

  it("fails closed when pinned computer is offline even when hub Docker is available", () => {
    const offlineBridge: BridgeCandidate = {
      id: "win-host-1",
      name: "Desktop Windows PC",
      online: false,
      lastSeenAt: now - 35_000,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };

    const resolution = resolveSelectedMachine({
      hostId: "win-host-1",
      bridges: [offlineBridge],
      hubDockerAvailable: true,
      now,
    });

    expect(resolution.kind).toBe("blocked");
    if (resolution.kind === "blocked") {
      expect(resolution.bridgeId).toBe("win-host-1");
      expect(resolution.reason).toMatch(/offline/i);
    }
  });

  it("fails closed when pinned computer is not found or revoked even when hub Docker is available", () => {
    const resolution = resolveSelectedMachine({
      hostId: "revoked-bridge-id",
      bridges: [],
      hubDockerAvailable: true,
      now,
    });

    expect(resolution.kind).toBe("blocked");
    if (resolution.kind === "blocked") {
      expect(resolution.bridgeId).toBe("revoked-bridge-id");
      expect(resolution.reason).toMatch(/not paired|revoked|no longer paired/i);
    }
  });

  it("fails closed when pinned computer lacks capability or permission was revoked", () => {
    const shellOnlyBridge: BridgeCandidate = {
      id: "shell-bridge",
      name: "Shell Only Server",
      online: true,
      lastSeenAt: now - 500,
      capabilities: ["shell"],
      grantedCapabilities: ["shell"],
    };

    const withoutCapability = resolveSelectedMachine({
      hostId: "shell-bridge",
      bridges: [shellOnlyBridge],
      hubDockerAvailable: true,
      now,
    });

    expect(withoutCapability.kind).toBe("blocked");
    if (withoutCapability.kind === "blocked") {
      expect(withoutCapability.reason).toMatch(/cannot run|lacks .* capability/i);
    }

    const ungrantedBridge: BridgeCandidate = {
      id: "ungranted-bridge",
      name: "Ungranted VM Host",
      online: true,
      lastSeenAt: now - 500,
      capabilities: ["local-vm"],
      grantedCapabilities: ["shell"], // local-vm permission revoked
    };

    const withoutGrant = resolveSelectedMachine({
      hostId: "ungranted-bridge",
      bridges: [ungrantedBridge],
      hubDockerAvailable: true,
      now,
    });

    expect(withoutGrant.kind).toBe("blocked");
    if (withoutGrant.kind === "blocked") {
      expect(withoutGrant.reason).toMatch(/cannot run|lacks .* capability/i);
    }
  });

  it("routes Auto to hub when hub Docker is available", () => {
    const availableBridge: BridgeCandidate = {
      id: "bridge-1",
      name: "Remote Mac",
      online: true,
      lastSeenAt: now - 500,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };

    const resolution = resolveSelectedMachine({
      hostId: null,
      bridges: [availableBridge],
      hubDockerAvailable: true,
      now,
    });

    expect(resolution.kind).toBe("hub");
  });

  it("routes Auto to a suitable online bridge when hub Docker is unavailable", () => {
    const staleBridge: BridgeCandidate = {
      id: "stale-bridge",
      name: "Stale Mac",
      online: true,
      lastSeenAt: now - 5_000,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };
    const freshBridge: BridgeCandidate = {
      id: "fresh-bridge",
      name: "Fresh Mac",
      online: true,
      lastSeenAt: now - 1_000,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };

    const resolution = resolveSelectedMachine({
      hostId: null,
      bridges: [staleBridge, freshBridge],
      hubDockerAvailable: false,
      now,
    });

    expect(resolution).toMatchObject({
      kind: "bridge",
      bridgeId: "fresh-bridge",
    });
  });

  it("routes Auto to hub fallback when neither hub Docker nor online bridge is available", () => {
    const offlineBridge: BridgeCandidate = {
      id: "offline-bridge",
      name: "Offline Mac",
      online: false,
      lastSeenAt: now - 50_000,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };

    const resolution = resolveSelectedMachine({
      hostId: null,
      bridges: [offlineBridge],
      hubDockerAvailable: false,
      now,
    });

    expect(resolution.kind).toBe("hub");
  });

  it("routes Auto to online bridge when envRelay override is active", () => {
    const onlineBridge: BridgeCandidate = {
      id: "relay-bridge",
      name: "Relay Mac",
      online: true,
      lastSeenAt: now - 500,
      capabilities: ["local-vm"],
      grantedCapabilities: ["local-vm"],
    };

    const resolution = resolveSelectedMachine({
      hostId: null,
      bridges: [onlineBridge],
      hubDockerAvailable: true,
      envRelay: true,
      now,
    });

    expect(resolution).toMatchObject({
      kind: "bridge",
      bridgeId: "relay-bridge",
    });
  });
});
