import { createHash } from "node:crypto";

import { friendlyNameFromHost, isGenericHubName } from "../../shared/fleet-presentation.ts";

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export type HermesEndpointStatus = "available" | "unavailable" | "unreadable";

export interface HermesEndpointDescriptor {
  endpointId: string;
  bridgeId: string;
  profile?: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  capabilityRevision: string;
  status: HermesEndpointStatus;
}

export interface HermesEndpointProfileProbe {
  name?: unknown;
  [key: string]: unknown;
}

export interface DiscoverLocalHermesEndpointsInput {
  bridgeId: string;
  computerName: string;
  hostInfo?: string;
  capabilities?: Record<string, boolean | undefined> | { [key: string]: boolean | undefined };
  profiles?: HermesEndpointProfileProbe[];
  profileStore?: "readable" | "unreadable" | "unavailable";
}

function validProfile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  if (!PROFILE_PATTERN.test(value)) return undefined;
  if (/^session(?:[-_]|$)/i.test(value) || /^(?:root|resolved)[-_]?session/i.test(value)) return undefined;
  return value.toLowerCase();
}

export function hermesEndpointId(bridgeId: string, profile: string): string {
  return `bridge:${bridgeId}:${profile.toLowerCase()}`;
}

export function hermesCapabilityRevision(capabilities: Record<string, boolean> = {}): string {
  const proven = Object.entries(capabilities)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .sort();
  return createHash("sha256").update(JSON.stringify(proven)).digest("hex").slice(0, 32);
}

function computerLabel(computerName: string, hostInfo?: string): string {
  const name = computerName.trim();
  if (isGenericHubName(name)) {
    return friendlyNameFromHost(hostInfo ?? name);
  }
  return name || "Connected computer";
}

function provenCapabilities(capabilities: Record<string, boolean | undefined> = {}): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

export function discoverLocalHermesEndpoints(input: DiscoverLocalHermesEndpointsInput): HermesEndpointDescriptor[] {
  const bridgeId = input.bridgeId.trim();
  const displayComputer = computerLabel(input.computerName, input.hostInfo);
  const capabilities = provenCapabilities(input.capabilities);
  const revision = hermesCapabilityRevision(capabilities);

  if (input.profileStore === "unreadable") {
    return [{
      endpointId: hermesEndpointId(bridgeId, "unreadable"),
      bridgeId,
      displayName: displayComputer,
      capabilities: {},
      capabilityRevision: revision,
      status: "unreadable",
    }];
  }
  if (input.profileStore === "unavailable") {
    return [{
      endpointId: hermesEndpointId(bridgeId, "unavailable"),
      bridgeId,
      displayName: displayComputer,
      capabilities: {},
      capabilityRevision: revision,
      status: "unavailable",
    }];
  }

  const seen = new Set<string>();
  const descriptors: HermesEndpointDescriptor[] = [];
  for (const probe of input.profiles ?? []) {
    const profile = validProfile(probe.name);
    if (!profile || seen.has(profile)) continue;
    seen.add(profile);
    descriptors.push({
      endpointId: hermesEndpointId(bridgeId, profile),
      bridgeId,
      profile,
      displayName: `${displayComputer} / ${profile}`,
      capabilities,
      capabilityRevision: revision,
      status: "available",
    });
  }
  return descriptors;
}
