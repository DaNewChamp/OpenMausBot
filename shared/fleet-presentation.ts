export type RuntimeProfile = "desktop-hub" | "headless-hub" | "desktop-client";

const GENERIC_HUB_NAMES = new Set([
  "computer",
  "desktop",
  "open maus",
  "open maus bot",
  "openmaus",
  "openmausbot",
  "v bot",
  "vbot",
  "bridge",
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface HubDisplayInput {
  name: string;
  host: string;
  alias?: string;
  runtimeProfile?: RuntimeProfile | string;
}

export interface BridgeRosterEntryLike {
  id: string;
  name: string;
  hostInfo?: string | null;
  online: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface PresentedBridgeEntry<T extends BridgeRosterEntryLike = BridgeRosterEntryLike> {
  entry: T;
  displayName: string;
  roleLabel: "Connected bridge" | "Previous registration";
  stale: boolean;
  hidden: boolean;
}

function normalizeGenericName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, " ");
}

function stripHostBrackets(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1");
}

function isAddressHost(host: string): boolean {
  const address = stripHostBrackets(host);
  return address.includes(":") || IPV4.test(address);
}

function titleCaseWord(word: string): string {
  switch (word.toLowerCase()) {
    case "macmini":
      return "Mac mini";
    case "macbook":
      return "MacBook";
    case "mac":
      return "Mac";
    case "mini":
      return "mini";
    default:
      return word.charAt(0).toUpperCase() + word.slice(1);
  }
}

export function isGenericHubName(name: string): boolean {
  const normalized = normalizeGenericName(name);
  return normalized.length === 0 || GENERIC_HUB_NAMES.has(normalized);
}

export function friendlyNameFromHost(host: string): string {
  const address = stripHostBrackets(host);
  if (!address || isAddressHost(address)) return "Connected computer";

  const hostName = address.split(".", 1)[0] ?? "";
  if (!hostName) return "Connected computer";

  const words = hostName
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCaseWord);
  return words.length === 0 ? "Connected computer" : words.join(" ");
}

function profileFallback(runtimeProfile?: string): string | null {
  if (runtimeProfile === "headless-hub") return "Headless V Bot hub";
  if (runtimeProfile === "desktop-client") return "V Bot client";
  return null;
}

/** Presentation-only hub label. Never used for authorization. */
export function resolveHubDisplayName(input: HubDisplayInput): string {
  const alias = input.alias?.trim();
  if (alias) return alias.slice(0, 80);

  const trimmed = input.name.trim();
  if (trimmed && !isGenericHubName(trimmed)) return trimmed;

  const profileName = profileFallback(input.runtimeProfile);
  if (profileName && isAddressHost(input.host)) return profileName;

  const fromHost = friendlyNameFromHost(input.host);
  if (fromHost !== "Connected computer") return fromHost;
  return profileName ?? fromHost;
}

function normalizeHostIdentity(hostInfo?: string | null): string | null {
  const trimmed = hostInfo?.trim();
  if (!trimmed) return null;
  const stripped = stripHostBrackets(trimmed).toLowerCase();
  if (!stripped) return null;
  if (isAddressHost(stripped)) return stripped;

  const dotIndex = stripped.indexOf(".");
  if (dotIndex === -1) return stripped;

  const suffix = stripped.slice(dotIndex + 1);
  if (suffix === "local" || suffix === "lan") {
    return stripped.slice(0, dotIndex);
  }
  return stripped;
}

const GENERIC_BRIDGE_FALLBACK = "Connected bridge";

function bridgeDisplayName(entry: BridgeRosterEntryLike): string {
  const host = entry.hostInfo?.trim() ?? "";
  if (isGenericHubName(entry.name)) {
    if (host) {
      const fromHost = friendlyNameFromHost(host);
      if (fromHost !== "Connected computer") return fromHost;
    }
    return GENERIC_BRIDGE_FALLBACK;
  }
  const trimmed = entry.name.trim();
  if (trimmed) return trimmed;
  if (host) {
    const fromHost = friendlyNameFromHost(host);
    if (fromHost !== "Connected computer") return fromHost;
  }
  return GENERIC_BRIDGE_FALLBACK;
}

function pickCanonicalIndex<T extends BridgeRosterEntryLike>(group: T[]): number {
  let best = 0;
  for (let index = 1; index < group.length; index += 1) {
    const candidate = group[index]!;
    const current = group[best]!;
    if (candidate.online !== current.online) {
      if (candidate.online) best = index;
      continue;
    }
    if (candidate.lastSeenAt !== current.lastSeenAt) {
      if (candidate.lastSeenAt > current.lastSeenAt) best = index;
      continue;
    }
    if (candidate.createdAt > current.createdAt) best = index;
  }
  return best;
}

/** Label stale bridge rows using host identity only; never merge by display name. */
export function presentBridgeRoster<T extends BridgeRosterEntryLike>(
  bridges: readonly T[],
): PresentedBridgeEntry<T>[] {
  const grouped = new Map<string, T[]>();
  const ungrouped: T[] = [];

  for (const entry of bridges) {
    const identity = normalizeHostIdentity(entry.hostInfo);
    if (!identity) {
      ungrouped.push(entry);
      continue;
    }
    const bucket = grouped.get(identity);
    if (bucket) bucket.push(entry);
    else grouped.set(identity, [entry]);
  }

  const presented: PresentedBridgeEntry<T>[] = [];

  for (const entry of ungrouped) {
    presented.push({
      entry,
      displayName: bridgeDisplayName(entry),
      roleLabel: "Connected bridge",
      stale: false,
      hidden: false,
    });
  }

  for (const group of grouped.values()) {
    if (group.length === 1) {
      const entry = group[0]!;
      presented.push({
        entry,
        displayName: bridgeDisplayName(entry),
        roleLabel: "Connected bridge",
        stale: false,
        hidden: false,
      });
      continue;
    }

    const canonicalIndex = pickCanonicalIndex(group);
    const ordered = group
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        if (left.index === canonicalIndex) return -1;
        if (right.index === canonicalIndex) return 1;
        if (left.entry.online !== right.entry.online) return left.entry.online ? -1 : 1;
        return right.entry.lastSeenAt - left.entry.lastSeenAt;
      });

    for (const { entry, index } of ordered) {
      const stale = index !== canonicalIndex && !entry.online;
      presented.push({
        entry,
        displayName: bridgeDisplayName(entry),
        roleLabel: stale ? "Previous registration" : "Connected bridge",
        stale,
        hidden: false,
      });
    }
  }

  return presented.sort((left, right) => {
    if (left.stale !== right.stale) return left.stale ? 1 : -1;
    if (left.entry.online !== right.entry.online) return left.entry.online ? -1 : 1;
    return right.entry.lastSeenAt - left.entry.lastSeenAt;
  });
}
