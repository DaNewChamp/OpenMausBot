import type { AppConfig } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";
import {
  defaultReconstructedHost,
  detectReconstructedRuntime,
  fetchVbotActivity,
  fetchVbotBots,
  fetchVbotGroups,
  fetchVbotProviders,
  fetchVbotRouter,
  isVbotBotId,
  parseVbotPromptBody,
  parseVbotRouterPatch,
  publicDisabledReason,
  publicVbotErrorReason,
  ReconstructedVbotError,
  sessionsToCatalog,
  setVbotRouter,
  submitStableReconstructedPrompt,
  stopVbotBot,
  submitVbotTurn,
  type PublicVbotActivity,
  type PublicVbotProviderCatalog,
  type PublicVbotRouterState,
  type PublicVbotStopResult,
  type PublicVbotTurnResult,
  type ReconstructedDisabledCode,
  type ReconstructedProbe,
  type ReconstructedRuntimeHost,
  type VbotTypedErrorBody,
} from "./drivers/grok-reconstructed.ts";

export type VBotPrimaryEngine = "openmaus" | "grokReconstructed";

export interface VBotSyncedBot {
  readonly id: string;
  readonly label: string;
  readonly busy?: boolean;
  readonly isActive?: boolean;
  readonly isRunning?: boolean;
  readonly model?: string;
}

export interface VBotSyncedGroup {
  readonly id: string;
  readonly label: string;
  readonly memberIds: readonly string[];
  readonly busyBotId?: string | null;
}

export interface VBotModelCapabilities {
  readonly defaultModel: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly sendPrompt: boolean;
  readonly images: boolean;
  readonly queueing: boolean;
  readonly steer: boolean;
  readonly stop: boolean;
  readonly attachments: boolean;
}

/** Capabilities of the selected desktop engine itself. Unlike the per-model
 * flags above this is intentionally explicit about the reconstructed
 * adapter's narrow, verified surface so clients can disable unsupported
 * affordances without guessing from an absent field. */
export interface VBotEngineCapabilities {
  readonly roster: boolean;
  readonly sendPrompt: boolean;
  readonly transcriptTail: boolean;
  readonly events: boolean;
  readonly attachments: boolean;
  readonly queueing: boolean;
  readonly steer: boolean;
  readonly stop: boolean;
  readonly mcp: boolean;
  readonly computer: boolean;
  readonly localVm: boolean;
}

export interface VBotEngineStatus {
  readonly id: VBotPrimaryEngine;
  readonly displayName: string;
  readonly state: "available" | "unavailable";
  readonly code?: ReconstructedDisabledCode;
  readonly reason?: string;
  readonly version?: string | null;
}

export interface VBotEngineSync {
  readonly primaryEngine: VBotPrimaryEngine;
  readonly activeSource: VBotPrimaryEngine;
  readonly fallback: boolean;
  readonly fallbackCode: ReconstructedDisabledCode | null;
  readonly fallbackReason: string | null;
  readonly engines: readonly VBotEngineStatus[];
  readonly bots: readonly VBotSyncedBot[];
  readonly groups: readonly VBotSyncedGroup[];
  readonly modelCapabilities: VBotModelCapabilities | null;
  readonly engineCapabilities: VBotEngineCapabilities;
  readonly providers: PublicVbotProviderCatalog | null;
  readonly router: PublicVbotRouterState | null;
}

export interface OpenMausSyncSnapshot {
  readonly bots: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly title: string;
    readonly busy?: boolean;
    readonly activity?: string;
    readonly modelSelection: { readonly instanceId: string; readonly model: string };
  }>;
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly memberIds: readonly string[];
    readonly busyBotId?: string | null;
  }>;
}

export function vbotPrimaryEngine(cfg: AppConfig): VBotPrimaryEngine {
  return cfg.vbot?.primaryEngine === "grokReconstructed" ? "grokReconstructed" : "openmaus";
}

export function parseVBotPrimaryEnginePatch(body: unknown): VBotPrimaryEngine | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, "primaryEngine")) return null;
  const value = record.primaryEngine;
  if (value === "openmaus" || value === "grokReconstructed") return value;
  return null;
}

function openMausEngineStatus(): VBotEngineStatus {
  return {
    id: "openmaus",
    displayName: "OpenMaus",
    state: "available",
    version: null,
  };
}

function reconstructedEngineStatus(probe: ReconstructedProbe): VBotEngineStatus {
  if (probe.ok) {
    return {
      id: "grokReconstructed",
      displayName: "Grok Reconstructed",
      state: "available",
      version: "0.18-reconstructed",
    };
  }
  return {
    id: "grokReconstructed",
    displayName: "Grok Reconstructed",
    state: "unavailable",
    code: probe.code,
    reason: publicDisabledReason(probe.code),
    version: "0.18-reconstructed",
  };
}

function openMausBots(snapshot: OpenMausSyncSnapshot): VBotSyncedBot[] {
  return snapshot.bots.map((bot) => ({
    id: bot.id,
    label: bot.title.trim() || bot.name.trim() || bot.id,
    busy: bot.busy === true || bot.activity === "working",
    model: bot.modelSelection.model,
  }));
}

function openMausGroups(snapshot: OpenMausSyncSnapshot): VBotSyncedGroup[] {
  return snapshot.groups.map((group) => ({
    id: group.id,
    label: group.name.trim() || group.id,
    memberIds: [...group.memberIds],
    busyBotId: group.busyBotId ?? null,
  }));
}

function reconstructedBots(probe: Extract<ReconstructedProbe, { ok: true }>): VBotSyncedBot[] {
  return probe.roster.bots.map((bot) => ({
    id: bot.id,
    label: bot.label,
    isActive: bot.isActive,
    isRunning: bot.isRunning,
    busy: bot.isRunning === true,
  }));
}

function reconstructedGroups(probe: Extract<ReconstructedProbe, { ok: true }>): VBotSyncedGroup[] {
  return probe.roster.groups.map((group) => ({
    id: group.id,
    label: group.label,
    memberIds: [...group.memberIds],
    busyBotId: null,
  }));
}

function reconstructedModelCapabilities(
  probe: Extract<ReconstructedProbe, { ok: true }>,
  catalog: ModelCatalog,
): VBotModelCapabilities {
  return {
    defaultModel: catalog.default,
    models: catalog.options.map((option) => ({ id: option.id, label: option.label })),
    sendPrompt: probe.capabilities.sendPrompt,
    images: false,
    queueing: false,
    steer: probe.capabilities.steer,
    stop: probe.capabilities.stop,
    attachments: false,
  };
}

function reconstructedEngineCapabilities(
  probe: Extract<ReconstructedProbe, { ok: true }>,
): VBotEngineCapabilities {
  return {
    roster: probe.capabilities.listAgents,
    sendPrompt: probe.capabilities.sendPrompt,
    transcriptTail: probe.capabilities.transcriptTail,
    events: probe.capabilities.events,
    attachments: false,
    queueing: false,
    steer: probe.capabilities.steer,
    stop: probe.capabilities.stop,
    mcp: false,
    computer: false,
    localVm: false,
  };
}

function openMausEngineCapabilities(): VBotEngineCapabilities {
  return {
    roster: true,
    sendPrompt: true,
    transcriptTail: true,
    events: true,
    attachments: true,
    queueing: true,
    steer: true,
    stop: true,
    mcp: true,
    computer: true,
    localVm: true,
  };
}

function openMausModelCapabilities(): VBotModelCapabilities {
  return {
    defaultModel: "",
    models: [],
    sendPrompt: true,
    images: true,
    queueing: true,
    steer: true,
    stop: true,
    attachments: true,
  };
}

export function buildVBotEngineSync(input: {
  primaryEngine: VBotPrimaryEngine;
  reconstructed: ReconstructedProbe;
  openmaus: OpenMausSyncSnapshot;
}): VBotEngineSync {
  const engines = [openMausEngineStatus(), reconstructedEngineStatus(input.reconstructed)];
  const reconstructedAvailable = input.reconstructed.ok;
  const wantsReconstructed = input.primaryEngine === "grokReconstructed";
  const fallback = wantsReconstructed && !reconstructedAvailable;
  const activeSource: VBotPrimaryEngine = wantsReconstructed && reconstructedAvailable ? "grokReconstructed" : "openmaus";
  const fallbackCode = fallback && !input.reconstructed.ok ? input.reconstructed.code : null;
  const fallbackReason = fallbackCode ? publicDisabledReason(fallbackCode) : null;

  if (activeSource === "grokReconstructed" && input.reconstructed.ok) {
    const catalog = sessionsToCatalog(input.reconstructed.sessions);
    return {
      primaryEngine: input.primaryEngine,
      activeSource,
      fallback,
      fallbackCode,
      fallbackReason,
      engines,
      bots: reconstructedBots(input.reconstructed),
      groups: reconstructedGroups(input.reconstructed),
      modelCapabilities: reconstructedModelCapabilities(input.reconstructed, catalog),
      engineCapabilities: reconstructedEngineCapabilities(input.reconstructed),
      providers: null,
      router: null,
    };
  }

  return {
    primaryEngine: input.primaryEngine,
    activeSource: "openmaus",
    fallback,
    fallbackCode,
    fallbackReason,
    engines,
    bots: openMausBots(input.openmaus),
    groups: openMausGroups(input.openmaus),
    modelCapabilities: openMausModelCapabilities(),
    engineCapabilities: openMausEngineCapabilities(),
    providers: null,
    router: null,
  };
}

export async function probeVBotReconstructed(
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<ReconstructedProbe> {
  return detectReconstructedRuntime(host);
}

export function vbotTypedErrorBody(error: ReconstructedVbotError): VbotTypedErrorBody {
  return error.toJSON();
}

export function requireReconstructedRead(
  reconstructed: ReconstructedProbe,
): Extract<ReconstructedProbe, { ok: true }> {
  if (!reconstructed.ok) {
    throw new ReconstructedVbotError(
      "reconstructed-unavailable",
      publicDisabledReason(reconstructed.code),
    );
  }
  if (!reconstructed.capabilities.vbotInterop) {
    throw new ReconstructedVbotError(
      "vbot-interop-unavailable",
      publicVbotErrorReason("vbot-interop-unavailable"),
    );
  }
  return reconstructed;
}

function requireReconstructedRuntime(
  reconstructed: ReconstructedProbe,
): Extract<ReconstructedProbe, { ok: true }> {
  if (!reconstructed.ok) {
    throw new ReconstructedVbotError(
      "reconstructed-unavailable",
      publicDisabledReason(reconstructed.code),
    );
  }
  return reconstructed;
}

export function requireReconstructedMutation(
  primaryEngine: VBotPrimaryEngine,
  reconstructed: ReconstructedProbe,
): Extract<ReconstructedProbe, { ok: true }> {
  if (primaryEngine !== "grokReconstructed") {
    throw new ReconstructedVbotError(
      "engine-mutation-blocked",
      "Grok Reconstructed is not the selected desktop engine.",
    );
  }
  if (!reconstructed.ok) {
    throw new ReconstructedVbotError(
      "engine-mutation-blocked",
      publicDisabledReason(reconstructed.code),
    );
  }
  return reconstructed;
}

export async function enrichVBotEngineSync(
  sync: VBotEngineSync,
  reconstructed: ReconstructedProbe,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<VBotEngineSync> {
  if (sync.activeSource !== "grokReconstructed" || !reconstructed.ok || !reconstructed.capabilities.vbotInterop) {
    return sync;
  }
  try {
    const [providers, router] = await Promise.all([
      fetchVbotProviders(host, reconstructed),
      fetchVbotRouter(host, reconstructed),
    ]);
    return { ...sync, providers, router };
  } catch {
    return sync;
  }
}

export async function readReconstructedVbotBots(
  reconstructed: ReconstructedProbe,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<VBotSyncedBot[]> {
  const runtime = requireReconstructedRuntime(reconstructed);
  if (!runtime.capabilities.vbotInterop) {
    return runtime.roster.bots.map((bot) => ({
      id: bot.id,
      label: bot.label,
      isActive: bot.isActive,
      isRunning: bot.isRunning,
      busy: bot.isRunning === true,
    }));
  }
  const bots = await fetchVbotBots(host, runtime);
  return bots.map((bot) => ({
    id: bot.id,
    label: bot.label,
    isActive: bot.isActive,
    isRunning: bot.isRunning,
    busy: bot.isRunning === true,
  }));
}

export async function readReconstructedVbotGroups(
  reconstructed: ReconstructedProbe,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<VBotSyncedGroup[]> {
  const runtime = requireReconstructedRuntime(reconstructed);
  if (!runtime.capabilities.vbotInterop) {
    return runtime.roster.groups.map((group) => ({
      id: group.id,
      label: group.label,
      memberIds: [...group.memberIds],
      busyBotId: null,
    }));
  }
  const groups = await fetchVbotGroups(host, runtime);
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    memberIds: [...group.memberIds],
    busyBotId: null,
  }));
}

export async function readReconstructedVbotProviders(
  reconstructed: ReconstructedProbe,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<PublicVbotProviderCatalog> {
  return fetchVbotProviders(host, requireReconstructedRead(reconstructed));
}

export async function readReconstructedVbotRouter(
  reconstructed: ReconstructedProbe,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<PublicVbotRouterState> {
  return fetchVbotRouter(host, requireReconstructedRead(reconstructed));
}

export async function readReconstructedVbotActivity(
  reconstructed: ReconstructedProbe,
  botId: string,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<PublicVbotActivity> {
  if (!isVbotBotId(botId)) {
    throw new ReconstructedVbotError("invalid_request", "bot id is invalid");
  }
  return fetchVbotActivity(host, requireReconstructedRead(reconstructed), botId);
}

export async function mutateReconstructedVbotRouter(
  primaryEngine: VBotPrimaryEngine,
  reconstructed: ReconstructedProbe,
  body: unknown,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<PublicVbotRouterState> {
  const runtime = requireReconstructedMutation(primaryEngine, reconstructed);
  if (runtime.capabilities.selectHostRouter !== true) {
    throw new ReconstructedVbotError(
      "unsupported_action",
      "Host provider selection is unavailable on Grok Reconstructed.",
      { action: "provider_model_select" },
    );
  }
  const patch = parseVbotRouterPatch(body);
  if (patch == null) {
    throw new ReconstructedVbotError("invalid_request", "provider or modelId is required");
  }
  return setVbotRouter(host, runtime, patch);
}

export async function mutateReconstructedVbotTurn(
  primaryEngine: VBotPrimaryEngine,
  reconstructed: ReconstructedProbe,
  botId: string,
  body: unknown,
  steered: boolean,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<PublicVbotTurnResult> {
  const runtime = requireReconstructedMutation(primaryEngine, reconstructed);
  if (!isVbotBotId(botId)) {
    throw new ReconstructedVbotError("invalid_request", "bot id is invalid");
  }
  const parsed = parseVbotPromptBody(body);
  if (parsed == null) {
    throw new ReconstructedVbotError("invalid_request", "prompt is required");
  }
  if (runtime.capabilities.sendPrompt !== true) {
    throw new ReconstructedVbotError(
      "unsupported_action",
      "Prompt submission is unavailable on Grok Reconstructed.",
      { action: "per_bot_router" },
    );
  }
  if (steered && runtime.capabilities.steer !== true) {
    throw new ReconstructedVbotError(
      "unsupported_action",
      "Steering is unavailable on Grok Reconstructed.",
      { action: "per_bot_router" },
    );
  }
  if (!runtime.capabilities.vbotInterop) {
    if (steered) {
      throw new ReconstructedVbotError(
        "unsupported_action",
        "Steering is unavailable on the stable reconstructed gateway.",
        { action: "per_bot_router" },
      );
    }
    return submitStableReconstructedPrompt(host, runtime, botId, parsed);
  }
  return submitVbotTurn(host, runtime, botId, parsed, steered);
}

export async function mutateReconstructedVbotStop(
  primaryEngine: VBotPrimaryEngine,
  reconstructed: ReconstructedProbe,
  botId: string,
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<PublicVbotStopResult> {
  const runtime = requireReconstructedMutation(primaryEngine, reconstructed);
  if (!isVbotBotId(botId)) {
    throw new ReconstructedVbotError("invalid_request", "bot id is invalid");
  }
  if (runtime.capabilities.stop !== true) {
    throw new ReconstructedVbotError(
      "unsupported_action",
      "Stop is unavailable because Grok Reconstructed has no bound interrupt.",
      { action: "stop" },
    );
  }
  return stopVbotBot(host, runtime, botId);
}
