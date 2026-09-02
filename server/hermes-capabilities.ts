export const HERMES_NATIVE_CAPABILITY_KEYS = [
  "memory",
  "learning",
  "skills",
  "moa",
  "routines",
  "approvals",
  "groups",
  "messaging",
  "events",
  "finalResponse",
  "queueing",
  "steering",
  "attachments",
  "computerTools",
] as const;

export type HermesNativeCapability = (typeof HERMES_NATIVE_CAPABILITY_KEYS)[number];
export type HermesCapabilityAvailability = "available" | "unavailable";
export type HermesCapabilityManifest = Record<HermesNativeCapability, HermesCapabilityAvailability>;

const SECRETISH_KEY = /token|secret|password|authorization|HERMES_HOME|path|session/i;

const ALIASES: Record<string, HermesNativeCapability> = {
  memory: "memory",
  learning: "learning",
  skills: "skills",
  moa: "moa",
  routines: "routines",
  routinesRead: "routines",
  approvals: "approvals",
  groups: "groups",
  messaging: "messaging",
  messageAgent: "messaging",
  events: "events",
  finalResponse: "finalResponse",
  queueing: "queueing",
  steering: "steering",
  steer: "steering",
  attachments: "attachments",
  computerTools: "computerTools",
};

function emptyManifest(): HermesCapabilityManifest {
  const manifest = {} as HermesCapabilityManifest;
  for (const key of HERMES_NATIVE_CAPABILITY_KEYS) manifest[key] = "unavailable";
  return manifest;
}

function collectFlags(source: Record<string, unknown> | undefined, votes: Map<HermesNativeCapability, boolean[]>): void {
  if (!source) return;
  for (const [rawKey, value] of Object.entries(source)) {
    if (SECRETISH_KEY.test(rawKey)) continue;
    if (typeof value !== "boolean") continue;
    const key = ALIASES[rawKey];
    if (!key) continue;
    const list = votes.get(key) ?? [];
    list.push(value);
    votes.set(key, list);
  }
}

/** Fail closed. Version strings never imply support. A capability is available
 * only when every observed/descriptor source that mentioned it reported true. */
export function negotiateHermesCapabilities(input: {
  observed?: Record<string, unknown>;
  descriptors?: Array<{ capabilities?: Record<string, boolean> }>;
  version?: string;
}): HermesCapabilityManifest {
  void input.version;
  const votes = new Map<HermesNativeCapability, boolean[]>();
  collectFlags(input.observed, votes);
  for (const descriptor of input.descriptors ?? []) {
    collectFlags(descriptor.capabilities, votes);
  }
  const manifest = emptyManifest();
  for (const key of HERMES_NATIVE_CAPABILITY_KEYS) {
    const list = votes.get(key);
    if (list && list.length > 0 && list.every((flag) => flag === true)) {
      manifest[key] = "available";
    }
  }
  return manifest;
}
