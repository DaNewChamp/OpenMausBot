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
