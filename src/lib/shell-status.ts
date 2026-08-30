export type ComputerEngineKind = "vm" | "vps" | "local" | "cloud" | "off" | "auto";

export interface ShellEngineBadge {
  kind: ComputerEngineKind;
  label: string;
}

export function computerEngineKind(input: {
  computer?: "cloud" | "vm" | "local" | "off";
  cloudBackend?: "box" | "vps";
}): ComputerEngineKind {
  if (input.computer === "vm") return "vm";
  if (input.computer === "local") return "local";
  if (input.computer === "off") return "off";
  if (input.computer === "cloud") return input.cloudBackend === "vps" ? "vps" : "cloud";
  return input.cloudBackend === "vps" ? "vps" : "auto";
}

export function computerEngineBadge(input: {
  computer?: "cloud" | "vm" | "local" | "off";
  cloudBackend?: "box" | "vps";
}): ShellEngineBadge {
  const kind = computerEngineKind(input);
  switch (kind) {
    case "vm":
      return { kind, label: "Local VM" };
    case "vps":
      return { kind, label: "VPS engine" };
    case "local":
      return { kind, label: "This computer" };
    case "cloud":
      return { kind, label: "Cloud computer" };
    case "off":
      return { kind, label: "Computer off" };
    default:
      return { kind, label: "Auto engine" };
  }
}

export type BridgeHealthKind = "connected" | "pairing" | "offline" | "unknown";

export interface BridgeHealth {
  kind: BridgeHealthKind;
  label: string;
}

export function bridgeHealth(input: {
  demo?: boolean;
  connected?: boolean;
  companionEnabled?: boolean;
  pairedCount?: number;
  liveCount?: number;
}): BridgeHealth {
  if (input.demo) return { kind: "connected", label: "Bridge live" };
  if (input.companionEnabled === false) return { kind: "offline", label: "Bridge off" };
  if ((input.liveCount ?? 0) > 0) return { kind: "connected", label: "Bridge live" };
  if ((input.pairedCount ?? 0) > 0) return { kind: "pairing", label: "Phone paired" };
  if (input.connected) return { kind: "pairing", label: "Ready to pair" };
  return { kind: "unknown", label: "Bridge unknown" };
}

/** Mobile catalog is names and models only — never keys, paths, or tokens. */
export function sanitizeProviderCatalog(
  instances: ReadonlyArray<{
    instanceId: string;
    displayName: string;
    driverKind: string;
    models?: { default: string; options?: Array<{ id: string; label: string }> };
  }>,
): Array<{ id: string; name: string; driver: string; defaultModel: string }> {
  return instances.map((instance) => ({
    id: instance.instanceId,
    name: instance.displayName,
    driver: instance.driverKind,
    defaultModel: instance.models?.default ?? "",
  }));
}
