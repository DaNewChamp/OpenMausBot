import type { Bot, Group, InstanceInfo, ModelSelection } from "@/state/store";
import type { MausColor } from "@/lib/mascot";

export type VBotPrimaryEngine = "openmaus" | "grokReconstructed";
export const VBOT_ENGINE_IDS = ["openmaus", "grokReconstructed"] as const;

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
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  readonly sendPrompt: boolean;
  readonly images: boolean;
  readonly queueing: boolean;
  readonly steer: boolean;
  readonly stop: boolean;
  readonly attachments: boolean;
}

export type VBotEngineCode = string;

export interface VBotEngineStatus {
  readonly id: VBotPrimaryEngine;
  readonly displayName: string;
  readonly state: "available" | "unavailable";
  readonly code?: VBotEngineCode;
  readonly reason?: string;
  readonly version?: string | null;
}

export type VBotProviderId = "cursor" | "claude-code" | "codex" | "openrouter";

export interface VBotProviderModel {
  readonly id: string;
  readonly current: boolean;
  readonly selectable: boolean;
}

export interface VBotProvider {
  readonly id: VBotProviderId;
  readonly label: string;
  readonly current: boolean;
  readonly selectable: boolean;
  readonly modelSelectable: boolean;
  readonly models: readonly VBotProviderModel[];
}

export interface VBotProviderCatalog {
  readonly scope: "host";
  readonly perBotSelection: false;
  readonly currentProvider: VBotProviderId;
  readonly currentModelId: string;
  readonly providers: readonly VBotProvider[];
}

export interface VBotRouterState extends VBotProviderCatalog {
  readonly selected: {
    readonly provider: VBotProviderId;
    readonly modelId: string;
    readonly scope: "host";
  };
}

export interface VBotEngineSync {
  readonly primaryEngine: VBotPrimaryEngine;
  readonly activeSource: VBotPrimaryEngine;
  readonly fallback: boolean;
  readonly fallbackCode: VBotEngineCode | null;
  readonly fallbackReason: string | null;
  readonly engines: readonly VBotEngineStatus[];
  readonly bots: readonly VBotSyncedBot[];
  readonly groups: readonly VBotSyncedGroup[];
  readonly modelCapabilities: VBotModelCapabilities | null;
  readonly providers: VBotProviderCatalog | null;
  readonly router: VBotRouterState | null;
}

const AGENT_ID = /^[\w.-]{1,200}$/;
const LABEL_MAX = 120;
const TEXT_MAX = 500;
const PROVIDERS: readonly VBotProviderId[] = [
  "cursor",
  "claude-code",
  "codex",
  "openrouter",
];
const COLORS: readonly MausColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, max = TEXT_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function boundedLabel(value: unknown, fallback: string): string {
  const label = boundedText(value, LABEL_MAX);
  return label ?? fallback.slice(0, LABEL_MAX);
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseEngine(value: unknown): VBotPrimaryEngine | null {
  return value === "openmaus" || value === "grokReconstructed" ? value : null;
}

function parseProvider(value: unknown): VBotProviderId | null {
  return typeof value === "string" &&
    PROVIDERS.includes(value as VBotProviderId)
    ? (value as VBotProviderId)
    : null;
}

function parseBot(value: unknown): VBotSyncedBot | null {
  const item = record(value);
  const id =
    typeof item?.id === "string" && AGENT_ID.test(item.id) ? item.id : null;
  if (!item || !id) return null;
  return {
    id,
    label: boundedLabel(item.label, id),
    ...(boolOrUndefined(item.busy) === undefined
      ? {}
      : { busy: item.busy as boolean }),
    ...(boolOrUndefined(item.isActive) === undefined
      ? {}
      : { isActive: item.isActive as boolean }),
    ...(boolOrUndefined(item.isRunning) === undefined
      ? {}
      : { isRunning: item.isRunning as boolean }),
    ...(boundedText(item.model, 200) === null
      ? {}
      : { model: boundedText(item.model, 200)! }),
  };
}

function parseGroup(value: unknown): VBotSyncedGroup | null {
  const item = record(value);
  const id =
    typeof item?.id === "string" && AGENT_ID.test(item.id) ? item.id : null;
  if (!item || !id || !Array.isArray(item.memberIds)) return null;
  const memberIds = item.memberIds.filter(
    (member): member is string =>
      typeof member === "string" && AGENT_ID.test(member),
  );
  const busyBotId =
    item.busyBotId === null
      ? null
      : typeof item.busyBotId === "string" && AGENT_ID.test(item.busyBotId)
        ? item.busyBotId
        : undefined;
  return {
    id,
    label: boundedLabel(item.label, id),
    memberIds,
    ...(busyBotId === undefined ? {} : { busyBotId }),
  };
}

function parseModels(
  value: unknown,
  modelSelectable: boolean,
): VBotProviderModel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const models: VBotProviderModel[] = [];
  for (const row of value) {
    const item = record(row);
    const id = boundedText(item?.id, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      current: item?.current === true,
      selectable: modelSelectable && item?.selectable === true,
    });
  }
  return models;
}

function parseCatalog(value: unknown): VBotProviderCatalog | null {
  const item = record(value);
  const currentProvider = parseProvider(item?.currentProvider);
  const currentModelId = boundedText(item?.currentModelId, 200);
  if (!currentProvider || !currentModelId || !Array.isArray(item?.providers))
    return null;
  const providers: VBotProvider[] = [];
  const seen = new Set<VBotProviderId>();
  for (const row of item.providers) {
    const provider = record(row);
    const id = parseProvider(provider?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const modelSelectable = provider?.modelSelectable === true;
    providers.push({
      id,
      label: boundedLabel(provider?.label, id),
      current: provider?.current === true,
      selectable: provider?.selectable === true,
      modelSelectable,
      models: parseModels(provider?.models, modelSelectable),
    });
  }
  if (providers.length === 0) return null;
  return {
    scope: "host",
    perBotSelection: false,
    currentProvider,
    currentModelId,
    providers,
  };
}

function parseRouter(value: unknown): VBotRouterState | null {
  const catalog = parseCatalog(value);
  if (!catalog) return null;
  const item = record(value);
  const selected = record(item?.selected);
  const provider = parseProvider(selected?.provider) ?? catalog.currentProvider;
  const modelId = boundedText(selected?.modelId, 200) ?? catalog.currentModelId;
  return { ...catalog, selected: { provider, modelId, scope: "host" } };
}

function parseModelCapabilities(value: unknown): VBotModelCapabilities | null {
  const item = record(value);
  const defaultModel = boundedText(item?.defaultModel, 200);
  if (defaultModel === null) return null;
  const models: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  if (Array.isArray(item?.models)) {
    for (const row of item.models) {
      const model = record(row);
      const id = boundedText(model?.id, 200);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: boundedLabel(model?.label, id) });
    }
  }
  return {
    defaultModel,
    models,
    sendPrompt: item?.sendPrompt === true,
    images: item?.images === true,
    queueing: item?.queueing === true,
    steer: item?.steer === true,
    stop: item?.stop === true,
    attachments: item?.attachments === true,
  };
}

function parseStatus(value: unknown): VBotEngineStatus | null {
  const item = record(value);
  const id = parseEngine(item?.id);
  const state =
    item?.state === "available" || item?.state === "unavailable"
      ? item.state
      : null;
  if (!item || !id || !state) return null;
  const code = boundedText(item.code, 120);
  const reason = boundedText(item.reason, TEXT_MAX);
  const version = item.version === null ? null : boundedText(item.version, 120);
  return {
    id,
    displayName: boundedLabel(
      item.displayName,
      id === "openmaus" ? "OpenMaus" : "Grok Reconstructed",
    ),
    state,
    ...(code ? { code } : {}),
    ...(reason ? { reason } : {}),
    ...(version !== null ? { version } : {}),
  };
}

/** Defensive client-side parser. It intentionally keeps only public engine capability fields. */
export function parseVBotEngineSync(value: unknown): VBotEngineSync | null {
  const item = record(value);
  const primaryEngine = parseEngine(item?.primaryEngine);
  const activeSource = parseEngine(item?.activeSource);
  if (!primaryEngine || !activeSource) return null;
  const engines = Array.isArray(item?.engines)
    ? item.engines
        .map(parseStatus)
        .filter((status): status is VBotEngineStatus => status !== null)
    : [];
  const bots = Array.isArray(item?.bots)
    ? item.bots
        .map(parseBot)
        .filter((bot): bot is VBotSyncedBot => bot !== null)
    : [];
  const groups = Array.isArray(item?.groups)
    ? item.groups
        .map(parseGroup)
        .filter((group): group is VBotSyncedGroup => group !== null)
    : [];
  const fallbackCode =
    item?.fallbackCode === null ? null : boundedText(item?.fallbackCode, 120);
  const fallbackReason =
    item?.fallbackReason === null
      ? null
      : boundedText(item?.fallbackReason, TEXT_MAX);
  return {
    primaryEngine,
    activeSource,
    fallback: item?.fallback === true,
    fallbackCode,
    fallbackReason,
    engines,
    bots,
    groups,
    modelCapabilities: parseModelCapabilities(item?.modelCapabilities),
    providers: parseCatalog(item?.providers),
    router: parseRouter(item?.router),
  };
}

export function isVBotReconstructedActive(
  sync: VBotEngineSync | null | undefined,
): boolean {
  return (
    sync?.primaryEngine === "grokReconstructed" &&
    sync.activeSource === "grokReconstructed" &&
    !sync.fallback
  );
}

export function vbotThreadId(source: VBotPrimaryEngine, id: string): string {
  return `vbot-${source}-${id}`;
}

function colorFor(id: string): MausColor {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1)
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

function modelSelectionFor(
  sync: VBotEngineSync,
  row: VBotSyncedBot,
): ModelSelection {
  const selected = sync.router?.selected;
  const instanceId = selected?.provider ?? "grokReconstructed";
  const model =
    row.model ??
    selected?.modelId ??
    sync.modelCapabilities?.defaultModel ??
    "active";
  return { instanceId, model };
}

function syntheticBot(
  sync: VBotEngineSync,
  row: VBotSyncedBot,
  previous?: Bot,
): Bot {
  const threadId = vbotThreadId(sync.activeSource, row.id);
  const keepTranscript = previous?.threadId === threadId;
  return {
    ...(previous ?? {}),
    id: row.id,
    threadId,
    name: row.label,
    title: previous?.title ?? "",
    description:
      previous?.description ??
      `Synced from ${sync.activeSource === "grokReconstructed" ? "Grok Reconstructed" : "OpenMaus"}`,
    notifications: previous?.notifications ?? true,
    color: previous?.color ?? colorFor(row.id),
    unread: previous?.unread ?? false,
    busy: row.busy === true || row.isRunning === true,
    activity: row.busy === true || row.isRunning === true ? "working" : "idle",
    modelSelection: keepTranscript ? previous!.modelSelection : modelSelectionFor(sync, row),
    messages: keepTranscript ? previous.messages : [],
    activeLeafId: keepTranscript ? previous.activeLeafId : null,
  };
}

function syntheticGroup(
  sync: VBotEngineSync,
  row: VBotSyncedGroup,
  previous?: Group,
): Group {
  const threadId = vbotThreadId(sync.activeSource, row.id);
  const keepTranscript = previous?.threadId === threadId;
  return {
    ...(previous ?? {}),
    id: row.id,
    threadId,
    name: row.label,
    memberIds: [...row.memberIds],
    defaultResponder: previous?.defaultResponder ?? { kind: "everyone" },
    bulletin: previous?.bulletin ?? "",
    unread: previous?.unread ?? false,
    createdAt: previous?.createdAt ?? 0,
    busyBotId: row.busyBotId ?? null,
    messages: keepTranscript ? previous.messages : [],
  };
}

function mergeOpenMausBots(
  sync: VBotEngineSync,
  rows: readonly VBotSyncedBot[],
  current: readonly Bot[],
): Bot[] {
  const byId = new Map(current.map((bot) => [bot.id, bot]));
  return rows.map((row) => {
    const previous = byId.get(row.id);
    if (!previous || previous.threadId.startsWith("vbot-grokReconstructed-"))
      return syntheticBot(
        sync,
        row,
        previous?.threadId.startsWith("vbot-openmaus-") ? previous : undefined,
      );
    return {
      ...previous,
      name: row.label || previous.name,
      busy: row.busy ?? previous.busy,
      ...(row.model
        ? { modelSelection: { ...previous.modelSelection, model: row.model } }
        : {}),
    };
  });
}

function mergeOpenMausGroups(
  rows: readonly VBotSyncedGroup[],
  current: readonly Group[],
): Group[] {
  const byId = new Map(current.map((group) => [group.id, group]));
  return rows.map((row) => {
    const previous = byId.get(row.id);
    if (!previous) {
      return {
        id: row.id,
        threadId: `openmaus-${row.id}`,
        name: row.label,
        memberIds: [...row.memberIds],
        defaultResponder: { kind: "everyone" },
        bulletin: "",
        unread: false,
        createdAt: 0,
        busyBotId: row.busyBotId ?? null,
        messages: [],
      } satisfies Group;
    }
    return {
      ...previous,
      name: row.label || previous.name,
      memberIds: [...row.memberIds],
      busyBotId: row.busyBotId ?? null,
    };
  });
}

export function foldVBotEngineSync(
  sync: VBotEngineSync,
  currentBots: readonly Bot[],
  currentGroups: readonly Group[],
): { bots: Bot[]; groups: Group[] } {
  if (sync.activeSource === "grokReconstructed") {
    const bots = sync.bots.map((row) =>
      syntheticBot(
        sync,
        row,
        currentBots.find((bot) => bot.id === row.id),
      ),
    );
    const groups = sync.groups.map((row) =>
      syntheticGroup(
        sync,
        row,
        currentGroups.find((group) => group.id === row.id),
      ),
    );
    return { bots, groups };
  }
  return {
    bots: mergeOpenMausBots(sync, sync.bots, currentBots),
    groups: mergeOpenMausGroups(sync.groups, currentGroups),
  };
}

function providerDriverKind(id: VBotProviderId): string {
  switch (id) {
    case "cursor":
      return "cursorAgent";
    case "claude-code":
      return "claudeAgent";
    case "codex":
      return "codex";
    case "openrouter":
      return "openrouter";
  }
}

/** Adapts the reconstructed host's sanitized provider catalog to the desktop picker shape. */
export function vbotProviderInstances(sync: VBotEngineSync): InstanceInfo[] {
  const catalog = sync.router ?? sync.providers;
  const fallbackModels = sync.modelCapabilities?.models ?? [];
  if (!catalog) {
    return [
      {
        instanceId: "grokReconstructed",
        driverKind: "grokReconstructed",
        displayName: "Grok Reconstructed",
        snapshot: {
          state: "available",
          authenticated: true,
          version: "0.18-reconstructed",
          billing: "subscription",
        },
        models: {
          default: sync.modelCapabilities?.defaultModel ?? "active",
          options:
            fallbackModels.length > 0
              ? fallbackModels.map((model) => ({ ...model }))
              : [{ id: "active", label: "Active reconstructed bot" }],
        },
        capabilities: sync.modelCapabilities ?? undefined,
        access: "subscription",
      },
    ];
  }
  return catalog.providers.map((provider) => {
    const current = provider.id === catalog.currentProvider;
    const models =
      provider.models.length > 0
        ? provider.models.map((model) => ({
            id: model.id,
            label: model.id,
            custom: false,
          }))
        : current
          ? fallbackModels.map((model) => ({ ...model, custom: false }))
          : [];
    const defaultModel = current
      ? catalog.currentModelId
      : (models[0]?.id ?? "active");
    return {
      instanceId: provider.id,
      driverKind: providerDriverKind(provider.id),
      displayName: provider.label,
      snapshot: {
        state: provider.selectable ? "available" : "unavailable",
        reason: provider.selectable
          ? undefined
          : "This provider is not selectable on the reconstructed host.",
        authenticated: provider.selectable,
        version: "0.18-reconstructed",
        billing: "subscription",
      },
      models: { default: defaultModel, options: models },
      capabilities: sync.modelCapabilities ?? undefined,
      access: "subscription",
    } satisfies InstanceInfo;
  });
}

export type VBotMutationAction = "turns" | "steer" | "stop";

export function vbotMutationPath(
  botId: string,
  action: VBotMutationAction,
): string {
  if (!AGENT_ID.test(botId)) throw new Error("bot id is invalid");
  return `/api/vbot/bots/${botId}/${action}`;
}

export function reconstructedActionUnavailable(
  sync: VBotEngineSync | null | undefined,
  action: "send" | "steer" | "stop" | "provider",
): string | null {
  if (!sync || sync.primaryEngine !== "grokReconstructed") return null;
  if (!isVBotReconstructedActive(sync))
    return (
      sync.fallbackReason ??
      "Grok Reconstructed is not available on this computer."
    );
  const caps = sync.modelCapabilities;
  if (action === "send" && caps?.sendPrompt !== true)
    return "Prompt submission is unavailable on Grok Reconstructed.";
  if (action === "steer" && caps?.steer !== true)
    return "Steering is unavailable on Grok Reconstructed.";
  if (action === "stop" && caps?.stop !== true)
    return "Stopping is unavailable on Grok Reconstructed.";
  if (action === "provider" && !(sync.router ?? sync.providers))
    return "Provider selection is unavailable on Grok Reconstructed.";
  return null;
}
