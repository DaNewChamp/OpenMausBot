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
import type { HermesBotEngine } from "./engines/hermes.ts";
import type { HermesEngineDescription } from "./engines/index.ts";

export type HermesSetupState = "disabled" | "ready" | "connected" | "unavailable";

export type HermesSetupReason =
  | NonNullable<HermesDiscovery["reason"]>
  | "state_unavailable"
  | "malformed_response";

export interface HermesSetupProfile extends HermesRosterRow {
  botId?: string;
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
  botExists: (id: string) => boolean;
}

export interface ConnectHermesProfileOptions {
  registry: HermesSetupRegistry;
  profile?: string;
  loadBindings?: HermesBindingLoader;
  setBinding?: HermesBindingWriter;
  removeBinding?: (botId: string) => BindingStoreResult<void>;
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

function publicProfile(row: HermesRosterRow, botId?: string): HermesSetupProfile {
  return {
    profile: row.profile,
    handle: row.handle,
    displayName: row.displayName,
    description: row.description,
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    canonicalChat: row.canonicalChat,
    availability: row.availability,
    ...(botId ? { botId } : {}),
  };
}

export function projectHermesSetupStatus(options: ProjectHermesSetupStatusOptions): HermesSetupStatus {
  if (!options.enabled) {
    return { state: "disabled", profiles: [], capabilities: { ...EMPTY_CAPABILITIES } };
  }

  const description = options.description;
  if (description.state !== "available") {
    return {
      state: "unavailable",
      reason: unavailableReason(description),
      profiles: description.profiles.map((row) => publicProfile(row)),
      capabilities: { ...description.capabilities },
    };
  }

  if (options.bindings.state === "unavailable") {
    return {
      state: "unavailable",
      reason: options.bindings.code,
      profiles: description.profiles.map((row) => publicProfile(row)),
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
        profiles: description.profiles.map((row) => publicProfile(row)),
        capabilities: { ...description.capabilities },
      };
    }
    if (!options.botExists(botId)) {
      return {
        state: "unavailable",
        reason: "state_unavailable",
        profiles: description.profiles.map((row) => publicProfile(row)),
        capabilities: { ...description.capabilities },
      };
    }
    const profile = safeProfile(binding.profile);
    if (!profile || profileBindings.has(profile)) {
      return {
        state: "unavailable",
        reason: "malformed_response",
        profiles: description.profiles.map((row) => publicProfile(row)),
        capabilities: { ...description.capabilities },
      };
    }
    profileBindings.set(profile, botId);
  }

  const profiles = description.profiles.map((row) => {
    const botId = row.profile ? profileBindings.get(row.profile) : undefined;
    if (botId && row.availability !== "available") return null;
    return publicProfile(row, botId);
  });
  if (profiles.some((row) => row === null)) {
    return {
      state: "unavailable",
      reason: "state_unavailable",
      profiles: description.profiles.map((row) => publicProfile(row)),
      capabilities: { ...description.capabilities },
    };
  }

  const discoveredProfiles = new Set(description.profiles.map((row) => row.profile).filter(Boolean));
  if (discoveredProfiles.size !== description.profiles.filter((row) => row.profile).length) {
    return {
      state: "unavailable",
      reason: "malformed_response",
      profiles: description.profiles.map((row) => publicProfile(row)),
      capabilities: { ...description.capabilities },
    };
  }
  for (const profile of profileBindings.keys()) {
    if (!discoveredProfiles.has(profile)) {
      return {
        state: "unavailable",
        reason: "state_unavailable",
        profiles: description.profiles.map((row) => publicProfile(row)),
        capabilities: { ...description.capabilities },
      };
    }
  }

  const safeProfiles = profiles.filter((row): row is HermesSetupProfile => row !== null);
  const connected = safeProfiles.some((profile) => profile.botId !== undefined);
  // A binding proves only the V Bot↔Hermes profile association. It does not
  // prove that the current discovery still sees this profile's canonical
  // `Bot Chat`; only a live `present` row may advertise that capability.
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
  return projectHermesSetupStatus({ enabled: registry.isEnabled, description, bindings, botExists: options.botExists });
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

async function connectHermesProfileUnlocked(options: ConnectHermesProfileOptions): Promise<ConnectedHermesProfile> {
  if (!options.registry.isEnabled) throw setupError("state_unavailable");
  let description: HermesEngineDescription;
  try {
    description = await options.registry.discover();
  } catch {
    throw setupError("state_unavailable");
  }
  if (description.state !== "available") throw setupError(unavailableReason(description));

  const row = profileForRequest(description.profiles, options.profile);
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
    const connectedProfile = status.profiles.find((candidate) => candidate.profile === profile);
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

  const rollback = () => {
    // Remove even when the writer reported failure: an injected or interrupted
    // writer may have published before returning its safe error. The bot id is
    // freshly minted, so this cannot disturb an existing binding.
    try { removeBinding(created.id); } catch { /* leave the safe failure for the caller */ }
    try { options.deleteBot(created.id); } catch { /* best effort */ }
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
    const connectedProfile = status.profiles.find((candidate) => candidate.profile === profile);
    if (!connectedProfile) throw setupError("state_unavailable");
    return { botId: created.id, profile: connectedProfile, status, created: true };
  } catch (error) {
    rollback();
    if (error instanceof HermesEngineError) throw error;
    throw setupError("state_unavailable");
  }
}
