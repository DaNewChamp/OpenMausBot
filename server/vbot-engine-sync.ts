import type { AppConfig } from "./config.ts";
import type { ModelCatalog } from "./contracts.ts";
import {
  defaultReconstructedHost,
  detectReconstructedRuntime,
  publicDisabledReason,
  sessionsToCatalog,
  type ReconstructedDisabledCode,
  type ReconstructedProbe,
  type ReconstructedRuntimeHost,
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
  readonly attachments: boolean;
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
    steer: false,
    attachments: false,
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
  };
}

export async function probeVBotReconstructed(
  host: ReconstructedRuntimeHost = defaultReconstructedHost(),
): Promise<ReconstructedProbe> {
  return detectReconstructedRuntime(host);
}
