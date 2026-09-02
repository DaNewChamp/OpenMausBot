import type { ModelSelection } from "./contracts.ts";
import type { BotRecord } from "./store.ts";
import {
  loadHermesBindings,
  removeHermesBinding,
  setHermesBinding,
  type BindingStoreResult,
} from "./engines/bindings.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
  type HermesCapabilityFlags,
  type HermesDiscovery,
  type HermesRosterRow,
} from "./engines/contracts.ts";
import type { BridgeRegistry } from "./bridge-registry.ts";
import {
  loadHermesBridgeBindings,
  removeHermesBridgeBinding,
  setHermesBridgeBinding,
} from "./bridge-hermes-bindings.ts";
import type { HermesBridgeBinding } from "../shared/bridge-hermes-contract.ts";
import {
  annotateBridgeConnectedProfiles,
  discoverBridgeHermesPlacements,
  ensureBridgeHermesCanonical,
  mergeHermesSetupProfiles,
  placementKey,
  projectConnectedRemoteCapabilities,
  projectSetupSafeRemoteCapabilities,
  type HermesSetupPlacement,
} from "./hermes-bridge-integration.ts";
import type { HermesBotEngine } from "./engines/hermes.ts";
import type { HermesEngineDescription } from "./engines/index.ts";

export type HermesSetupState = "disabled" | "ready" | "connected" | "unavailable";

export type HermesSetupReason =
  | NonNullable<HermesDiscovery["reason"]>
  | "state_unavailable"
  | "malformed_response";

export interface HermesSetupProfile extends HermesRosterRow {
  botId?: string;
  placement?: HermesSetupPlacement;
}

export interface HermesSetupStatus {
  state: HermesSetupState;
  reason?: HermesSetupReason;
  profiles: HermesSetupProfile[];
  capabilities: HermesCapabilityFlags;
}

export interface HermesSetupRegistry {
  readonly isEnabled: boolean;
  readonly instanceId: string;
  discover(): Promise<HermesEngineDescription>;
  describe(): Promise<HermesEngineDescription>;
  forBinding(binding: HermesBotBinding): HermesBotEngine | null;
}

export interface HermesSetupStore {
  bot(id: string): Pick<BotRecord, "id"> | null;
}

export interface HermesSetupConnectStore extends HermesSetupStore {
  createBot(
    profile: Partial<Pick<BotRecord, "name" | "title" | "description" | "modelSelection">>,
    opts: { seedMessages: false },
  ): Pick<BotRecord, "id">;
  deleteBot(id: string): boolean;
}

export type HermesBindingLoader = () => BindingStoreResult<ReadonlyMap<string, HermesBotBinding>>;
export type HermesBindingWriter = (botId: string, binding: HermesBotBinding) => BindingStoreResult<void>;

export interface ProjectHermesSetupStatusOptions {
  enabled: boolean;
  description: HermesEngineDescription;
  bindings: BindingStoreResult<ReadonlyMap<string, HermesBotBinding>>;
  bridgeBindings?: ReturnType<typeof loadHermesBridgeBindings>;
  bridgeRegistry?: BridgeRegistry;
  remoteProfiles?: HermesSetupProfile[];
  remoteCapabilities?: HermesCapabilityFlags;
  botExists: (id: string) => boolean;
}

export interface ConnectHermesProfileOptions {
  registry: HermesSetupRegistry;
  profile?: string;
  placement?: HermesSetupPlacement;
  bridgeRegistry?: BridgeRegistry;
  loadBindings?: HermesBindingLoader;
  setBinding?: HermesBindingWriter;
  removeBinding?: (botId: string) => BindingStoreResult<void>;
  loadBridgeBindings?: () => ReturnType<typeof loadHermesBridgeBindings>;
  setBridgeBinding?: typeof setHermesBridgeBinding;
  removeBridgeBinding?: typeof removeHermesBridgeBinding;
  bot: (id: string) => Pick<BotRecord, "id"> | null;
  createBot: HermesSetupConnectStore["createBot"];
  deleteBot: (id: string) => boolean;
}

export interface ConnectedHermesProfile {
  botId: string;
  profile: HermesSetupProfile;
  status: HermesSetupStatus;
  created: boolean;
}

const EMPTY_CAPABILITIES: HermesCapabilityFlags = {
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

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

class SetupLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const setupLocks = new WeakMap<object, SetupLock>();

function lockForRegistry(registry: HermesSetupRegistry): SetupLock {
  let lock = setupLocks.get(registry);
  if (!lock) {
    lock = new SetupLock();
    setupLocks.set(registry, lock);
  }
  return lock;
}

function safeProfile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return undefined;
  if (value.trim() !== value || !PROFILE_PATTERN.test(value)) return undefined;
  if (/^session(?:[-_]|$)/i.test(value) || /^(?:root|resolved)[-_]?session/i.test(value)) return undefined;
  if (/^[0-9a-f]{16,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(value)) return undefined;
  return value.toLowerCase();
}

/** Normalize a caller-supplied profile without exposing the roster or any
 * provider diagnostics at the HTTP boundary. */
export function normalizeHermesSetupProfile(value: unknown): string | undefined {
  return safeProfile(value);
}

function setupError(code: HermesSetupReason | HermesEngineError["code"]): HermesEngineError {
  switch (code) {
    case "missing_cli":
    case "invalid_credentials":
    case "gateway_unavailable":
    case "state_unavailable":
    case "malformed_response":
    case "timeout":
    case "profile_unavailable":
      return new HermesEngineError(code);
    default:
      return new HermesEngineError("state_unavailable");
  }
}

function unavailableReason(
  description: HermesEngineDescription,
): HermesSetupReason {
  return description.reason ?? "state_unavailable";
}

function profileForRequest(
  profiles: readonly HermesRosterRow[],
  requested: string | undefined,
): HermesRosterRow {
  const available = profiles.filter((profile) => profile.availability === "available" && profile.profile);
  if (!available.length) throw setupError("profile_unavailable");

  if (requested !== undefined) {
    const normalized = safeProfile(requested);
    if (!normalized) throw setupError("profile_unavailable");
    const matches = available.filter((profile) => profile.profile === normalized || profile.handle === normalized);
    if (matches.length !== 1) throw setupError("profile_unavailable");
    return matches[0]!;
  }

  const defaultProfile = available.filter((profile) => profile.handle === "hermes" || profile.profile === "default");
  if (defaultProfile.length === 1) return defaultProfile[0]!;
  if (available.length === 1) return available[0]!;
  throw setupError("profile_unavailable");
}

function descriptionWithCanonical(
  description: HermesEngineDescription,
  profile: string,
): HermesEngineDescription {
  return {
    ...description,
    capabilities: { ...description.capabilities, canonicalChat: true },
    profiles: description.profiles.map((row) => row.profile === profile ? { ...row, canonicalChat: "present" } : row),
  };
}

function publicProfile(
  row: HermesRosterRow,
  placement: HermesSetupPlacement,
  botId?: string,
): HermesSetupProfile {
  return {
    profile: row.profile,
    handle: row.handle,
    displayName: row.displayName,
    description: row.description,
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    canonicalChat: row.canonicalChat,
    availability: row.availability,
    placement,
    ...(botId ? { botId } : {}),
  };
}

function projectRemoteHermesSetupStatus(options: ProjectHermesSetupStatusOptions): HermesSetupStatus {
  const remoteCapabilities = options.remoteCapabilities ?? { ...EMPTY_CAPABILITIES };
  let safeProfiles = [...(options.remoteProfiles ?? [])];
  if (options.bridgeBindings?.state === "available" && options.bridgeRegistry) {
    safeProfiles = annotateBridgeConnectedProfiles(
      safeProfiles,
      options.bridgeBindings.value,
      options.bridgeRegistry,
      options.botExists,
    );
  } else if (options.bridgeBindings?.state === "unavailable") {
    return {
      state: "unavailable",
      reason: options.bridgeBindings.code,
      profiles: safeProfiles,
      capabilities: projectSetupSafeRemoteCapabilities(remoteCapabilities),
    };
  }
  const connected = safeProfiles.some((profile) => profile.botId !== undefined);
  return {
    state: connected ? "connected" : "ready",
    profiles: safeProfiles,
    capabilities: connected
      ? projectConnectedRemoteCapabilities(remoteCapabilities, safeProfiles)
      : projectSetupSafeRemoteCapabilities(remoteCapabilities),
  };
}

export function projectHermesSetupStatus(options: ProjectHermesSetupStatusOptions): HermesSetupStatus {
  const mapUnavailableProfiles = (profiles: readonly HermesRosterRow[]) =>
    profiles.map((row) => publicProfile(row, { kind: "local", profile: row.profile }, undefined));

  const remoteProfiles = options.remoteProfiles ?? [];
  if (!options.enabled) {
    if (remoteProfiles.length === 0) {
      return { state: "disabled", profiles: [], capabilities: { ...EMPTY_CAPABILITIES } };
    }
    return projectRemoteHermesSetupStatus(options);
  }

  const description = options.description;
  if (description.state !== "available") {
    return {
      state: "unavailable",
      reason: unavailableReason(description),
      profiles: mapUnavailableProfiles(description.profiles),
      capabilities: { ...description.capabilities },
    };
  }

  if (options.bindings.state === "unavailable") {
    return {
      state: "unavailable",
      reason: options.bindings.code,
      profiles: mapUnavailableProfiles(description.profiles),
      capabilities: { ...description.capabilities },
    };
  }

  const profileBindings = new Map<string, string>();
  for (const [botId, binding] of options.bindings.value) {
    if (
      !binding ||
      binding.adapter !== "hermesBot" ||
      binding.canonicalTitle !== "Bot Chat" ||
      binding.bindingVersion !== 1
    ) {
      return {
        state: "unavailable",
        reason: "malformed_response",
        profiles: mapUnavailableProfiles(description.profiles),
        capabilities: { ...description.capabilities },
      };
    }
    if (!options.botExists(botId)) {
      return {
        state: "unavailable",
        reason: "state_unavailable",
        profiles: mapUnavailableProfiles(description.profiles),
        capabilities: { ...description.capabilities },
      };
    }
    const profile = safeProfile(binding.profile);
    if (!profile || profileBindings.has(`local:${profile}`)) {
      return {
        state: "unavailable",
        reason: "malformed_response",
        profiles: mapUnavailableProfiles(description.profiles),
        capabilities: { ...description.capabilities },
      };
    }
    profileBindings.set(`local:${profile}`, botId);
  }

  const localProfiles = description.profiles.map((row) => {
    const botId = row.profile ? profileBindings.get(`local:${row.profile}`) : undefined;
    if (botId && row.availability !== "available") return null;
    return publicProfile(row, { kind: "local", profile: row.profile }, botId);
  });
  if (localProfiles.some((row) => row === null)) {
    return {
      state: "unavailable",
      reason: "state_unavailable",
      profiles: mapUnavailableProfiles(description.profiles),
      capabilities: { ...description.capabilities },
    };
  }

  const discoveredProfiles = new Set(description.profiles.map((row) => row.profile).filter(Boolean));
  if (discoveredProfiles.size !== description.profiles.filter((row) => row.profile).length) {
    return {
      state: "unavailable",
      reason: "malformed_response",
      profiles: mapUnavailableProfiles(description.profiles),
      capabilities: { ...description.capabilities },
    };
  }
  for (const profile of profileBindings.keys()) {
    const localProfile = profile.replace(/^local:/, "");
    if (!discoveredProfiles.has(localProfile)) {
      return {
        state: "unavailable",
        reason: "state_unavailable",
        profiles: mapUnavailableProfiles(description.profiles),
        capabilities: { ...description.capabilities },
      };
    }
  }

  let safeProfiles = localProfiles.filter((row): row is HermesSetupProfile => row !== null);
  if (remoteProfiles.length) {
    safeProfiles = mergeHermesSetupProfiles(safeProfiles, remoteProfiles);
  }
  if (
    options.bridgeBindings?.state === "available" &&
    options.bridgeRegistry
  ) {
    safeProfiles = annotateBridgeConnectedProfiles(
      safeProfiles,
      options.bridgeBindings.value,
      options.bridgeRegistry,
      options.botExists,
    );
  } else if (options.bridgeBindings?.state === "unavailable") {
    return {
      state: "unavailable",
      reason: options.bridgeBindings.code,
      profiles: safeProfiles,
      capabilities: { ...description.capabilities },
    };
  }

  const connected = safeProfiles.some((profile) => profile.botId !== undefined);
  const canonicalChatProven = description.capabilities.canonicalChat
    && safeProfiles.some((profile) => profile.canonicalChat === "present");
  return {
    state: connected ? "connected" : "ready",
    profiles: safeProfiles.map((profile) => profile.botId
      ? { ...profile, ...(canonicalChatProven && profile.canonicalChat === "present" ? { canonicalChat: "present" as const } : {}) }
      : profile),
    capabilities: {
      ...description.capabilities,
      canonicalChat: canonicalChatProven,
    },
  };
}

export async function readHermesSetupStatus(
  registry: HermesSetupRegistry,
  options: {
    loadBindings?: HermesBindingLoader;
    loadBridgeBindings?: () => ReturnType<typeof loadHermesBridgeBindings>;
    bridgeRegistry?: BridgeRegistry;
    botExists: (id: string) => boolean;
  },
): Promise<HermesSetupStatus> {
  let description: HermesEngineDescription;
  try {
    description = registry.isEnabled ? await registry.discover() : await registry.describe();
  } catch {
    description = {
      state: "unavailable",
      reason: "state_unavailable",
      capabilities: { ...EMPTY_CAPABILITIES },
      profiles: [],
    };
  }
  let bindings: BindingStoreResult<ReadonlyMap<string, HermesBotBinding>>;
  try {
    bindings = (options.loadBindings ?? loadHermesBindings)();
  } catch {
    bindings = {
      state: "unavailable",
      code: "state_unavailable",
      message: new HermesEngineError("state_unavailable").message,
    };
  }
  let bridgeBindings: ReturnType<typeof loadHermesBridgeBindings> | undefined;
  try {
    bridgeBindings = (options.loadBridgeBindings ?? loadHermesBridgeBindings)();
  } catch {
    bridgeBindings = {
      state: "unavailable",
      code: "state_unavailable",
      message: new HermesEngineError("state_unavailable").message,
    };
  }
  let remoteDiscovery = { profiles: [] as HermesSetupProfile[], capabilities: { ...EMPTY_CAPABILITIES } };
  if (options.bridgeRegistry) {
    try {
      remoteDiscovery = await discoverBridgeHermesPlacements(options.bridgeRegistry);
    } catch {
      remoteDiscovery = { profiles: [], capabilities: { ...EMPTY_CAPABILITIES } };
    }
  }
  return projectHermesSetupStatus({
    enabled: registry.isEnabled,
    description,
    bindings,
    bridgeBindings,
    bridgeRegistry: options.bridgeRegistry,
    remoteProfiles: remoteDiscovery.profiles,
    remoteCapabilities: remoteDiscovery.capabilities,
    botExists: options.botExists,
  });
}

function safeBotName(row: HermesRosterRow): string {
  const candidate = row.displayName.trim() || row.profile || "Hermes";
  return candidate.slice(0, 80);
}

function safeModelSelection(registry: HermesSetupRegistry, row: HermesRosterRow): ModelSelection {
  return { instanceId: registry.instanceId, model: row.model?.trim() || "hermes" };
}

export async function connectHermesProfile(options: ConnectHermesProfileOptions): Promise<ConnectedHermesProfile> {
  return lockForRegistry(options.registry).run(() => connectHermesProfileUnlocked(options));
}

function profileRowForPlacement(
  profiles: readonly HermesSetupProfile[],
  placement: HermesSetupPlacement,
): HermesSetupProfile {
  const matches = profiles.filter((row) =>
    row.placement &&
    row.placement.kind === placement.kind &&
    row.placement.profile === placement.profile &&
    (placement.kind === "local" || row.placement.bridge?.toLowerCase() === placement.bridge?.toLowerCase()));
  if (matches.length !== 1 || matches[0]!.availability !== "available") {
    throw setupError("profile_unavailable");
  }
  return matches[0]!;
}

async function connectBridgeHermesProfile(options: ConnectHermesProfileOptions): Promise<ConnectedHermesProfile> {
  const placement = options.placement;
  if (!placement || placement.kind !== "bridge" || !placement.bridge) {
    throw setupError("profile_unavailable");
  }
  if (!options.bridgeRegistry) throw setupError("gateway_unavailable");
  const loadBridgeBindings = options.loadBridgeBindings ?? loadHermesBridgeBindings;
  const setBridgeBinding = options.setBridgeBinding ?? setHermesBridgeBinding;
  const removeBridgeBinding = options.removeBridgeBinding ?? removeHermesBridgeBinding;
  const before = loadBridgeBindings();
  if (before.state === "unavailable") throw setupError(before.code);

  const remoteDiscovery = await discoverBridgeHermesPlacements(options.bridgeRegistry);
  const row = profileRowForPlacement(remoteDiscovery.profiles, placement);
  const profile = safeProfile(row.profile);
  if (!profile) throw setupError("profile_unavailable");
  const { bridgeId } = await ensureBridgeHermesCanonical(options.bridgeRegistry, {
    kind: "bridge",
    bridge: placement.bridge,
    profile,
  });

  let existingBotId: string | undefined;
  for (const [botId, existing] of before.value) {
    if (existing.bridgeId !== bridgeId || safeProfile(existing.profile) !== profile) continue;
    if (existingBotId && existingBotId !== botId) throw setupError("malformed_response");
    existingBotId = botId;
  }
  if (existingBotId && !options.bot(existingBotId)) throw setupError("state_unavailable");

  const bridgeBinding: HermesBridgeBinding = { bridgeId, profile, bindingVersion: 1 };
  const localDescription = options.registry.isEnabled
    ? descriptionWithCanonical(await options.registry.describe(), profile)
    : undefined;

  const projectBridgeConnectStatus = (
    bridgeBindings: ReturnType<typeof loadHermesBridgeBindings>,
    botExists: (id: string) => boolean,
  ): HermesSetupStatus => {
    if (options.registry.isEnabled && localDescription) {
      return projectHermesSetupStatus({
        enabled: true,
        description: localDescription,
        bindings: { state: "available", value: new Map() },
        bridgeBindings,
        bridgeRegistry: options.bridgeRegistry,
        remoteProfiles: remoteDiscovery.profiles,
        remoteCapabilities: remoteDiscovery.capabilities,
        botExists,
      });
    }
    return projectHermesSetupStatus({
      enabled: false,
      description: {
        state: "unavailable",
        capabilities: { ...EMPTY_CAPABILITIES },
        profiles: [],
      },
      bindings: { state: "available", value: new Map() },
      bridgeBindings,
      bridgeRegistry: options.bridgeRegistry,
      remoteProfiles: remoteDiscovery.profiles,
      remoteCapabilities: remoteDiscovery.capabilities,
      botExists,
    });
  };

  const statusBase = projectBridgeConnectStatus(before, (id) => Boolean(options.bot(id)));

  if (existingBotId) {
    const connectedProfile = statusBase.profiles.find((candidate) =>
      candidate.placement && placementKey(candidate.placement) === placementKey(placement));
    if (!connectedProfile?.botId) throw setupError("state_unavailable");
    return {
      botId: existingBotId,
      profile: connectedProfile,
      status: { ...statusBase, state: "connected" },
      created: false,
    };
  }

  let created: Pick<BotRecord, "id">;
  try {
    created = options.createBot({
      name: safeBotName(row),
      title: "Hermes Bot Chat",
      description: row.description,
      modelSelection: safeModelSelection(options.registry, row),
    }, { seedMessages: false });
  } catch {
    throw setupError("state_unavailable");
  }

  const rollback = (): boolean => {
    let ok = true;
    try {
      const removed = removeBridgeBinding(created.id);
      if (removed.state === "unavailable") ok = false;
    } catch {
      ok = false;
    }
    try {
      options.deleteBot(created.id);
    } catch {
      ok = false;
    }
    try {
      const remaining = loadBridgeBindings();
      if (remaining.state === "unavailable" || remaining.value.has(created.id)) ok = false;
    } catch {
      ok = false;
    }
    try {
      if (options.bot(created.id)) ok = false;
    } catch {
      ok = false;
    }
    return ok;
  };

  try {
    const persisted = setBridgeBinding(created.id, bridgeBinding);
    if (persisted.state === "unavailable") throw setupError(persisted.code);
    const after = loadBridgeBindings();
    if (after.state === "unavailable" || after.value.get(created.id)?.profile !== profile) {
      throw setupError(after.state === "unavailable" ? after.code : "state_unavailable");
    }
    const status = projectBridgeConnectStatus(after, (id) => Boolean(options.bot(id) ?? (id === created.id ? created : null)));
    const connectedProfile = status.profiles.find((candidate) =>
      candidate.placement && placementKey(candidate.placement) === placementKey(placement));
    if (!connectedProfile) throw setupError("state_unavailable");
    return { botId: created.id, profile: connectedProfile, status, created: true };
  } catch (error) {
    if (!rollback()) throw setupError("state_unavailable");
    if (error instanceof HermesEngineError) throw error;
    throw setupError("state_unavailable");
  }
}

async function connectHermesProfileUnlocked(options: ConnectHermesProfileOptions): Promise<ConnectedHermesProfile> {
  if (options.placement?.kind === "bridge") {
    return connectBridgeHermesProfile(options);
  }
  if (!options.registry.isEnabled) throw setupError("state_unavailable");
  let description: HermesEngineDescription;
  try {
    description = await options.registry.discover();
  } catch {
    throw setupError("state_unavailable");
  }
  if (description.state !== "available") throw setupError(unavailableReason(description));

  const requestedProfile = options.placement?.profile ?? options.profile;
  const row = profileForRequest(description.profiles, requestedProfile);
  const profile = safeProfile(row.profile);
  if (!profile) throw setupError("profile_unavailable");
  const binding: HermesBotBinding = {
    adapter: "hermesBot",
    profile,
    canonicalTitle: "Bot Chat",
    bindingVersion: 1,
  };
  const loadBindings = options.loadBindings ?? loadHermesBindings;
  const setBinding = options.setBinding ?? setHermesBinding;
  const removeBinding = options.removeBinding ?? removeHermesBinding;
  const before = loadBindings();
  if (before.state === "unavailable") throw setupError(before.code);

  let existingBotId: string | undefined;
  for (const [botId, existing] of before.value) {
    if (safeProfile(existing.profile) !== profile) continue;
    if (existingBotId && existingBotId !== botId) throw setupError("malformed_response");
    existingBotId = botId;
  }
  if (existingBotId && !options.bot(existingBotId)) throw setupError("state_unavailable");

  const engine = options.registry.forBinding(binding);
  if (!engine) throw setupError("gateway_unavailable");
  const setupEngine = engine;
  try {
    if (setupEngine.ensureCanonical) await setupEngine.ensureCanonical(profile);
    else await engine.resolveCanonical(profile);
  } catch (error) {
    if (error instanceof HermesEngineError) throw error;
    throw setupError("upstream_error");
  }

  if (existingBotId) {
    const status = projectHermesSetupStatus({
      enabled: true,
      description: descriptionWithCanonical(description, profile),
      bindings: before,
      botExists: (id) => Boolean(options.bot(id)),
    });
    if (status.state !== "connected") throw setupError(status.reason ?? "state_unavailable");
    const connectedProfile = status.profiles.find((candidate) =>
      candidate.placement?.kind === "local" && candidate.profile === profile);
    if (!connectedProfile) throw setupError("state_unavailable");
    return {
      botId: existingBotId,
      profile: connectedProfile,
      status,
      created: false,
    };
  }

  let created: Pick<BotRecord, "id">;
  try {
    created = options.createBot({
      name: safeBotName(row),
      title: "Hermes Bot Chat",
      description: row.description,
      modelSelection: safeModelSelection(options.registry, row),
    }, { seedMessages: false });
  } catch {
    throw setupError("state_unavailable");
  }
  if (!created || typeof created.id !== "string" || created.id.length === 0) {
    throw setupError("malformed_response");
  }

  const rollback = (): boolean => {
    // Remove even when the writer reported failure: an injected or interrupted
    // writer may have published before returning its safe error. The bot id is
    // freshly minted, so this cannot disturb an existing binding. Reconcile
    // both stores before allowing the original failure to escape; a failed
    // delete must never be hidden as a harmless setup error.
    let ok = true;
    try {
      const removed = removeBinding(created.id);
      if (removed.state === "unavailable") ok = false;
    } catch {
      ok = false;
    }
    try {
      options.deleteBot(created.id);
    } catch {
      ok = false;
    }
    try {
      const remaining = loadBindings();
      if (remaining.state === "unavailable" || remaining.value.has(created.id)) ok = false;
    } catch {
      ok = false;
    }
    try {
      if (options.bot(created.id)) ok = false;
    } catch {
      ok = false;
    }
    return ok;
  };
  try {
    const persisted = setBinding(created.id, binding);
    if (persisted.state === "unavailable") throw setupError(persisted.code);
    const after = loadBindings();
    if (after.state === "unavailable" || after.value.get(created.id)?.profile !== profile) {
      throw setupError(after.state === "unavailable" ? after.code : "state_unavailable");
    }
    const status = projectHermesSetupStatus({
      enabled: true,
      description: descriptionWithCanonical(description, profile),
      bindings: after,
      botExists: (id) => Boolean(options.bot(id) ?? (id === created.id ? created : null)),
    });
    const connectedProfile = status.profiles.find((candidate) =>
      candidate.placement?.kind === "local" && candidate.profile === profile);
    if (!connectedProfile) throw setupError("state_unavailable");
    return { botId: created.id, profile: connectedProfile, status, created: true };
  } catch (error) {
    if (!rollback()) throw setupError("state_unavailable");
    if (error instanceof HermesEngineError) throw error;
    throw setupError("state_unavailable");
  }
}
