import type { BridgeCapability, BridgeRegistry } from "./bridge-registry.ts";

export interface BridgeCandidate {
  id: string;
  name?: string;
  online?: boolean;
  lastSeenAt?: number;
  capabilities?: BridgeCapability[] | string[];
  grantedCapabilities?: BridgeCapability[] | string[];
}

export type SelectedMachineResolution =
  | { kind: "hub"; bridgeId?: undefined; reason?: string }
  | { kind: "bridge"; bridgeId: string; reason?: string }
  | { kind: "blocked"; bridgeId?: string; reason: string };

export interface ResolveSelectedMachineOptions {
  hostId?: string | null;
  bridges: BridgeCandidate[] | BridgeRegistry;
  hubDockerAvailable?: boolean;
  capability?: BridgeCapability;
  envRelay?: boolean;
  now?: number;
}

export const BRIDGE_ONLINE_THRESHOLD_MS = 20_000;

function isBridgeRegistry(bridges: BridgeCandidate[] | BridgeRegistry): bridges is BridgeRegistry {
  return typeof (bridges as BridgeRegistry).list === "function";
}

function bridgeIsOnline(candidate: BridgeCandidate, now: number): boolean {
  if (candidate.online !== undefined) return Boolean(candidate.online);
  if (candidate.lastSeenAt !== undefined) return now - candidate.lastSeenAt <= BRIDGE_ONLINE_THRESHOLD_MS;
  return false;
}

function bridgeHasCapability(candidate: BridgeCandidate, capability: BridgeCapability): boolean {
  const advertised = candidate.capabilities ? candidate.capabilities.includes(capability) : false;
  const granted = candidate.grantedCapabilities ? candidate.grantedCapabilities.includes(capability) : true;
  return advertised && granted;
}

/**
 * Pure resolver for target execution:
 * Explicit hostId requires that exact compatible online bridge and fails closed
 * (blocked) if offline, revoked, or incompatible, even when hub Docker is available.
 * Auto uses existing precedence: hub Docker if available, otherwise suitable online bridge.
 */
export function resolveSelectedMachine(options: ResolveSelectedMachineOptions): SelectedMachineResolution {
  const now = options.now ?? Date.now();
  const capability: BridgeCapability = options.capability ?? "local-vm";
  const bridgeList: BridgeCandidate[] = isBridgeRegistry(options.bridges)
    ? options.bridges.list()
    : options.bridges ?? [];

  const rawHostId = options.hostId?.trim();
  const isExplicit = Boolean(
    rawHostId &&
      rawHostId.toLowerCase() !== "auto" &&
      rawHostId.toLowerCase() !== "local" &&
      rawHostId.toLowerCase() !== "hub",
  );

  if (isExplicit) {
    const hostId = rawHostId!;
    const candidate = bridgeList.find((b) => b.id === hostId);
    if (!candidate) {
      return {
        kind: "blocked",
        bridgeId: hostId,
        reason: "assigned Local VM host is no longer paired",
      };
    }

    if (!bridgeIsOnline(candidate, now)) {
      const displayName = candidate.name ?? hostId;
      return {
        kind: "blocked",
        bridgeId: hostId,
        reason: `assigned Local VM host "${displayName}" is offline`,
      };
    }

    if (!bridgeHasCapability(candidate, capability)) {
      const displayName = candidate.name ?? hostId;
      return {
        kind: "blocked",
        bridgeId: hostId,
        reason: `assigned host "${displayName}" cannot run a Local VM`,
      };
    }

    return {
      kind: "bridge",
      bridgeId: candidate.id,
      reason: `Routed to selected computer "${candidate.name ?? candidate.id}"`,
    };
  }

  // Auto mode: use existing precedence
  const onlineCompatible = bridgeList.filter(
    (b) => bridgeIsOnline(b, now) && bridgeHasCapability(b, capability),
  );

  const freshestBridge = [...onlineCompatible].sort(
    (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
  )[0];

  if (options.envRelay) {
    if (freshestBridge) {
      return {
        kind: "bridge",
        bridgeId: freshestBridge.id,
        reason: "Auto routed to online bridge via relay override",
      };
    }
    return {
      kind: "hub",
      reason: "Relay override requested but no online bridge matched; falling back to hub",
    };
  }

  if (options.hubDockerAvailable) {
    return {
      kind: "hub",
      reason: "Auto routed to hub local container runtime",
    };
  }

  if (freshestBridge) {
    return {
      kind: "bridge",
      bridgeId: freshestBridge.id,
      reason: `Auto routed to available bridge "${freshestBridge.name ?? freshestBridge.id}"`,
    };
  }

  return {
    kind: "hub",
    reason: "No compatible online bridge available; falling back to hub",
  };
}
