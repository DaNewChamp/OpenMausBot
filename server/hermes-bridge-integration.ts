import type { RuntimeEvent } from "./contracts.ts";
import type { BridgeRegistry } from "./bridge-registry.ts";
import type { HermesBridgeBindingStoreResult } from "./bridge-hermes-bindings.ts";
import {
  discoverHermesOnBridge,
  ensureCanonicalHermesOnBridge,
  HermesBridgeUnavailableError,
  interruptHermesOnBridge,
  sendHermesOnBridge,
} from "./bridge-hermes.ts";
import { resolveBridge } from "./bridge-exec.ts";
import type { BindingStoreResult } from "./engines/bindings.ts";
import {
  type HermesBridgeBinding,
  type ScrubbedRuntimeEvent,
} from "../shared/bridge-hermes-contract.ts";
import {
  HERMES_CAPABILITY_KEYS,
  HermesEngineError,
  type HermesBotBinding,
  type HermesCapabilityFlags,
} from "./engines/contracts.ts";
import type { HermesSetupProfile } from "./hermes-setup.ts";
import { normalizeHermesSetupProfile } from "./hermes-setup.ts";
import { negotiateHermesCapabilities, type HermesCapabilityManifest } from "./hermes-capabilities.ts";

export const HERMES_BOT_CHAT_TITLE = "Hermes Bot Chat" as const;

export function isBridgeHermesBotCandidate(
  bot: { title?: string; modelSelection: { instanceId: string } },
  hermesInstanceId: string,
): boolean {
  return bot.title === HERMES_BOT_CHAT_TITLE && bot.modelSelection.instanceId === hermesInstanceId;
}

export type HermesBotDispatchResolution =
  | { route: "local"; binding: HermesBotBinding }
  | { route: "bridge"; binding: HermesBridgeBinding }
  | { route: "local-unavailable"; code: "state_unavailable" | "malformed_response" }
  | { route: "bridge-unavailable"; code: "state_unavailable" | "malformed_response" }
  | { route: "none" };

/** Local Hermes bindings are authoritative. Bridge bindings apply only when the
 * bot has no local binding; an unreadable bridge sidecar fails closed only for
 * bots whose runtime metadata matches a bridge-connected Hermes setup bot. */
export function resolveHermesBotDispatch(
  botId: string,
  options: {
    localBindings: BindingStoreResult<ReadonlyMap<string, HermesBotBinding>>;
    bridgeBindings: HermesBridgeBindingStoreResult<ReadonlyMap<string, HermesBridgeBinding>>;
    bridgeCandidate: boolean;
  },
): HermesBotDispatchResolution {
  if (options.localBindings.state === "unavailable") {
    return { route: "local-unavailable", code: options.localBindings.code };
  }
  const localBinding = options.localBindings.value.get(botId);
  if (localBinding) return { route: "local", binding: localBinding };

  if (options.bridgeBindings.state === "available") {
    const bridgeBinding = options.bridgeBindings.value.get(botId);
    return bridgeBinding ? { route: "bridge", binding: bridgeBinding } : { route: "none" };
  }
  return options.bridgeCandidate
    ? { route: "bridge-unavailable", code: options.bridgeBindings.code }
    : { route: "none" };
}

export type HermesSetupPlacementKind = "local" | "bridge";

export interface HermesSetupPlacement {
  kind: HermesSetupPlacementKind;
  profile: string;
  bridge?: string;
}

const PLACEMENT_KINDS = new Set<HermesSetupPlacementKind>(["local", "bridge"]);

function safeBridgeName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/[\u0000-\u001f]/.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

export function normalizeHermesSetupPlacement(value: unknown): HermesSetupPlacement | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.bridgeId !== undefined || record.bridge_id !== undefined) return undefined;
  const kind = record.kind;
  if (kind !== "local" && kind !== "bridge") return undefined;
  const profile = normalizeHermesSetupProfile(record.profile);
  if (!profile) return undefined;
  if (kind === "local") return { kind, profile };
  const bridge = safeBridgeName(record.bridge);
  if (!bridge) return undefined;
  return { kind, profile, bridge };
}

export function parseHermesSetupConnectInput(body: unknown):
  | { ok: true; placement?: HermesSetupPlacement }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Hermes setup requires a JSON object" };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (values.placement !== undefined) {
    if (keys.some((key) => key !== "placement")) {
      return { ok: false, error: "Hermes setup accepts only placement" };
    }
    const placement = normalizeHermesSetupPlacement(values.placement);
    return placement
      ? { ok: true, placement }
      : { ok: false, error: "placement must name a Hermes profile and, for bridge placements, a bridge" };
  }
  if (keys.some((key) => key !== "profile")) {
    return { ok: false, error: "Hermes setup accepts only profile or placement" };
  }
  if (values.profile === undefined) return { ok: true };
  const profile = normalizeHermesSetupProfile(values.profile);
  return profile
    ? { ok: true, placement: { kind: "local", profile } }
    : { ok: false, error: "profile must be a Hermes profile name" };
}

export function placementKey(placement: HermesSetupPlacement): string {
  const bridge = placement.kind === "bridge" && placement.bridge
    ? placement.bridge.toLowerCase()
    : "hub";
  return `${placement.kind}:${bridge}:${placement.profile}`;
}

function publicBridgeProfile(
  bridgeName: string,
  row: HermesSetupProfile,
  botId?: string,
): HermesSetupProfile {
  return {
    ...row,
    placement: { kind: "bridge", bridge: bridgeName, profile: row.profile },
    ...(botId ? { botId } : {}),
  };
}

const EMPTY_HERMES_CAPABILITIES: HermesCapabilityFlags = {
  roster: false,
  canonicalChat: false,
  send: false,
  finalResponse: false,
  events: false,
  stop: false,
  routinesRead: false,
  messageAgent: false,
  groups: false,
  crossMachine: false,
  queueing: false,
  steer: false,
  attachments: false,
  adoptMint: false,
  approvals: false,
  exclusiveSubmit: false,
};

export interface BridgeHermesDiscoveryResult {
  profiles: HermesSetupProfile[];
  capabilities: HermesCapabilityFlags;
  nativeCapabilities: HermesCapabilityManifest;
}

export function mergeHermesCapabilitiesConservatively(
  capabilities: readonly HermesCapabilityFlags[],
): HermesCapabilityFlags {
  if (capabilities.length === 0) return { ...EMPTY_HERMES_CAPABILITIES };
  const output = { ...capabilities[0]! };
  for (let index = 1; index < capabilities.length; index += 1) {
    const next = capabilities[index]!;
    for (const key of HERMES_CAPABILITY_KEYS) {
      output[key] = output[key] && next[key];
    }
  }
  return output;
}

/** Setup status exposes only roster from remote discovery until a profile connects. */
export function projectSetupSafeRemoteCapabilities(
  capabilities: HermesCapabilityFlags,
): HermesCapabilityFlags {
  return {
    ...EMPTY_HERMES_CAPABILITIES,
    roster: capabilities.roster,
  };
}

export function projectConnectedRemoteCapabilities(
  capabilities: HermesCapabilityFlags,
  profiles: readonly HermesSetupProfile[],
): HermesCapabilityFlags {
  const canonicalChatProven = capabilities.canonicalChat
    && profiles.some((profile) => profile.botId !== undefined && profile.canonicalChat === "present");
  return {
    ...capabilities,
    canonicalChat: canonicalChatProven,
  };
}

export async function discoverBridgeHermesPlacements(
  registry: BridgeRegistry,
): Promise<BridgeHermesDiscoveryResult> {
  const bridges = registry.list().filter((bridge) =>
    bridge.online &&
    bridge.capabilities.includes("hermes") &&
    bridge.grantedCapabilities.includes("hermes"));
  const profiles: HermesSetupProfile[] = [];
  const capabilitySets: HermesCapabilityFlags[] = [];
  for (const bridge of bridges) {
    try {
      const { discovery, bridgeName } = await discoverHermesOnBridge(registry, { bridgeId: bridge.id });
      if (discovery.state !== "available") continue;
      capabilitySets.push(discovery.capabilities);
      for (const row of discovery.profiles) {
        if (row.availability !== "available" || !row.profile) continue;
        profiles.push(publicBridgeProfile(bridgeName, {
          profile: row.profile,
          handle: row.handle,
          displayName: row.displayName,
          description: row.description,
          ...(row.model ? { model: row.model } : {}),
          ...(row.provider ? { provider: row.provider } : {}),
          canonicalChat: row.canonicalChat,
          availability: row.availability,
        }));
      }
    } catch {
      continue;
    }
  }
  const capabilities = mergeHermesCapabilitiesConservatively(capabilitySets);
  return {
    profiles,
    capabilities,
    nativeCapabilities: negotiateHermesCapabilities({
      observed: { ...capabilities },
      descriptors: capabilitySets.map((flags) => ({ capabilities: { ...flags } })),
    }),
  };
}

export function mergeHermesSetupProfiles(
  local: readonly HermesSetupProfile[],
  remote: readonly HermesSetupProfile[],
): HermesSetupProfile[] {
  const seen = new Set<string>();
  const output: HermesSetupProfile[] = [];
  for (const profile of [...local, ...remote]) {
    if (!profile.placement) continue;
    const key = placementKey(profile.placement);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(profile);
  }
  return output;
}

export function resolveBridgeBindingTarget(
  registry: BridgeRegistry,
  binding: HermesBridgeBinding,
): { bridge: string; profile: string } | null {
  const bridge = resolveBridge(registry, { bridgeId: binding.bridgeId, capability: "hermes" });
  if (!bridge) return null;
  return { bridge: bridge.name, profile: binding.profile };
}

export function bridgeBindingUnavailableError(error: unknown): HermesEngineError {
  if (error instanceof HermesBridgeUnavailableError) {
    const code = error.code === "bridge_unavailable" ? "gateway_unavailable" : error.code;
    if (code === "missing_cli" || code === "invalid_credentials" || code === "gateway_unavailable"
      || code === "state_unavailable" || code === "malformed_response" || code === "timeout"
      || code === "profile_unavailable") {
      return new HermesEngineError(code);
    }
    return new HermesEngineError("gateway_unavailable");
  }
  if (error instanceof HermesEngineError) return error;
  return new HermesEngineError("gateway_unavailable");
}

export function replayScrubbedHermesEvents(
  events: readonly ScrubbedRuntimeEvent[],
  instanceId: string,
  publish: (event: RuntimeEvent) => void,
): void {
  const seen = new Set<string>();
  for (const scrubbed of events) {
    if (seen.has(scrubbed.eventId)) continue;
    seen.add(scrubbed.eventId);
    publish({ ...(scrubbed as RuntimeEvent), providerInstanceId: instanceId });
  }
}

export async function dispatchHermesBridgeSend(options: {
  registry: BridgeRegistry;
  binding: HermesBridgeBinding;
  payload: {
    text: string;
    threadId: string;
    turnId: string;
    model?: string;
  };
  publishEvent: (event: RuntimeEvent) => void;
  instanceId?: string;
}): Promise<void> {
  if (!resolveBridge(options.registry, { bridgeId: options.binding.bridgeId, capability: "hermes" })) {
    throw new HermesEngineError("gateway_unavailable");
  }
  const { send } = await sendHermesOnBridge(options.registry, {
    profile: options.binding.profile,
    text: options.payload.text,
    threadId: options.payload.threadId,
    turnId: options.payload.turnId,
    ...(options.payload.model ? { model: options.payload.model } : {}),
  }, { bridgeId: options.binding.bridgeId });
  if (!send.ok) {
    throw new HermesEngineError(send.reason ?? "gateway_unavailable");
  }
  replayScrubbedHermesEvents(send.events, options.instanceId ?? "hermes", options.publishEvent);
}

export async function dispatchHermesBridgeInterrupt(
  registry: BridgeRegistry,
  binding: HermesBridgeBinding,
  turnId?: string,
): Promise<void> {
  if (!resolveBridge(registry, { bridgeId: binding.bridgeId, capability: "hermes" })) {
    throw new HermesEngineError("gateway_unavailable");
  }
  const { interrupt } = await interruptHermesOnBridge(registry, {
    profile: binding.profile,
    ...(turnId ? { turnId } : {}),
  }, { bridgeId: binding.bridgeId });
  if (!interrupt.ok) {
    throw new HermesEngineError(interrupt.reason ?? "gateway_unavailable");
  }
}

export async function ensureBridgeHermesCanonical(
  registry: BridgeRegistry,
  placement: HermesSetupPlacement & { kind: "bridge"; bridge: string },
): Promise<{ bridgeId: string; bridgeName: string }> {
  const bridge = resolveBridge(registry, { name: placement.bridge, capability: "hermes" });
  if (!bridge) throw new HermesEngineError("gateway_unavailable");
  const { canonical } = await ensureCanonicalHermesOnBridge(registry, placement.profile, {
    bridgeId: bridge.id,
  });
  if (canonical.state !== "present") {
    throw new HermesEngineError(canonical.reason ?? "profile_unavailable");
  }
  return { bridgeId: bridge.id, bridgeName: bridge.name };
}

export function isHermesSetupPlacementKind(value: unknown): value is HermesSetupPlacementKind {
  return typeof value === "string" && PLACEMENT_KINDS.has(value as HermesSetupPlacementKind);
}

export function withLocalPlacement(profile: HermesSetupProfile): HermesSetupProfile {
  return {
    ...profile,
    placement: { kind: "local", profile: profile.profile },
  };
}

export function annotateBridgeConnectedProfiles(
  profiles: readonly HermesSetupProfile[],
  bindings: ReadonlyMap<string, HermesBridgeBinding>,
  registry: BridgeRegistry,
  botExists: (id: string) => boolean,
): HermesSetupProfile[] {
  const byPlacement = new Map<string, string>();
  for (const [botId, binding] of bindings) {
    if (!botExists(botId)) continue;
    const target = resolveBridgeBindingTarget(registry, binding);
    if (!target) continue;
    byPlacement.set(placementKey({ kind: "bridge", bridge: target.bridge, profile: target.profile }), botId);
  }
  return profiles.map((profile) => {
    if (!profile.placement || profile.placement.kind !== "bridge" || !profile.placement.bridge) return profile;
    const botId = byPlacement.get(placementKey(profile.placement));
    return botId ? { ...profile, botId } : profile;
  });
}
