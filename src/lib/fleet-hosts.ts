export interface FleetHost {
  id: string;
  name: string;
  online: boolean;
  capabilities: string[];
  hostInfo?: string;
}

export function parseFleetHosts(raw: unknown): FleetHost[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const bridges = (raw as { bridges?: unknown }).bridges;
  if (!Array.isArray(bridges)) return [];
  const hosts: FleetHost[] = [];
  for (const entry of bridges) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    hosts.push({
      id: record.id,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : record.id,
      online: record.online === true,
      capabilities: Array.isArray(record.capabilities)
        ? record.capabilities.filter((item): item is string => typeof item === "string")
        : [],
      ...(typeof record.hostInfo === "string" ? { hostInfo: record.hostInfo } : {}),
    });
  }
  return hosts;
}

export function hostsWithCapability(hosts: readonly FleetHost[], capability: string): FleetHost[] {
  return hosts.filter((host) => host.capabilities.includes(capability));
}

export function preferredHostId(
  hosts: readonly FleetHost[],
  capability: string,
  pinned?: string | null,
): string | undefined {
  const options = hostsWithCapability(hosts, capability);
  if (pinned && options.some((host) => host.id === pinned)) return pinned;
  return options.find((host) => host.online)?.id ?? options[0]?.id;
}

/** Keep an explicit fleet pick even if that machine cannot host a Linux VM yet. */
export function selectedFleetHostId(
  hosts: readonly FleetHost[],
  pinned?: string | null,
): string | undefined {
  if (pinned && hosts.some((host) => host.id === pinned)) return pinned;
  return preferredHostId(hosts, "local-vm") ?? hosts.find((host) => host.online)?.id ?? hosts[0]?.id;
}

export function fleetHostLabel(host: FleetHost): string {
  const tags: string[] = [];
  if (!host.online) tags.push("offline");
  else if (!host.capabilities.includes("local-vm")) tags.push("no Linux VM");
  return tags.length ? `${host.name} (${tags.join(", ")})` : host.name;
}

export function fleetVmDeployBlockReason(host: FleetHost | undefined): string | null {
  if (!host) return "Pair a desktop or bridge, then pick it here.";
  if (!host.online) return `${host.name} is offline.`;
  if (!host.capabilities.includes("local-vm")) {
    return `${host.name} is connected, but it isn't hosting a Linux VM. Start Docker on that machine to Deploy.`;
  }
  return null;
}
