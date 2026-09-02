import {
  loadHermesBridgeBindings,
  removeHermesBridgeBinding,
  setHermesBridgeBinding,
} from "./bridge-hermes-bindings.ts";
import { ACTIVITY_BUSY, type BotRecord, type Store } from "./store.ts";
import {
  loadHermesBindings,
  projectHermesBindingPlacement,
  removeHermesBinding,
  setHermesBinding,
  type BindingStoreResult,
} from "./engines/bindings.ts";
import type { HermesBotBinding } from "./engines/contracts.ts";
import type { HermesBridgeBinding } from "../shared/bridge-hermes-contract.ts";

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_PROFILE_LENGTH = 64;
const MAX_INSTANCE_ID_LENGTH = 128;
const MAX_BRIDGE_ID_LENGTH = 128;
const MAX_HANDOFF_LENGTH = 500;
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];
const FORBIDDEN_HANDOFF_KEYS = /^(?:resume(?:cursors?|[_-]?cursors?)|session(?:[_-]?id)?|her[_-]?mes[_-]?home)$/i;

export type ProviderRuntimeBinding = {
  kind: "provider";
  instanceId: string;
  model?: string;
};

export type HermesRuntimeBinding = {
  kind: "hermes";
  placement:
    | { kind: "local"; profile: string }
    | { kind: "bridge"; bridgeId: string; profile: string };
  bindingVersion: 2;
};

export type BotRuntimeBinding = ProviderRuntimeBinding | HermesRuntimeBinding;

export type RuntimeRebindRequest = {
  targetBotId: string;
  binding: BotRuntimeBinding;
  contextMode: "summary" | "none";
  userRequested: boolean;
};

export type RuntimeRebindPlan = {
  previous: BotRuntimeBinding;
  next: BotRuntimeBinding;
  preservedBotId: string;
  handoffSummary: string;
  requiresApproval: boolean;
  expectedCapabilityRevision?: string;
};

export type RuntimeBindingResolution =
  | { state: "available"; value: BotRuntimeBinding }
  | {
      state: "unavailable";
      code: "state_unavailable" | "malformed_response";
      message: string;
    };

export type RuntimeEndpointState =
  | { state: "available"; endpointId: string; capabilityRevision: string }
  | { state: "unavailable"; endpointId?: string }
  | { state: "unreadable"; endpointId?: string }
  | { state: "missing" };

export type RuntimeRebindFailureCode =
  | "bot_active"
  | "bot_not_found"
  | "endpoint_unavailable"
  | "endpoint_unreadable"
  | "stale_endpoint"
  | "invalid_handoff"
  | "invalid_binding"
  | "state_unavailable";

export class RuntimeRebindError extends Error {
  readonly code: RuntimeRebindFailureCode;

  constructor(code: RuntimeRebindFailureCode, message: string) {
    super(message);
    this.name = "RuntimeRebindError";
    this.code = code;
  }
}

export type PlanBotRuntimeRebindInput = {
  bot: BotRecord;
  requested: BotRuntimeBinding;
  contextMode: "summary" | "none";
  context?: Record<string, unknown>;
  endpoint?: RuntimeEndpointState;
};

export type PlanBotRuntimeRebindResult =
  | { ok: true; plan: RuntimeRebindPlan }
  | { ok: false; code: RuntimeRebindFailureCode; message: string };

export type ApplyBotRuntimeRebindDeps = {
  store: Store;
  endpoint?: RuntimeEndpointState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

function validProfile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROFILE_LENGTH &&
    value.trim() === value &&
    PROFILE_PATTERN.test(value) &&
    !/^session(?:[-_]|$)/i.test(value) &&
    !/^(?:root|resolved)[-_]?session/i.test(value) &&
    !/^[0-9a-f]{16,}$/i.test(value)
  );
}

function validInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_INSTANCE_ID_LENGTH && value.trim() === value && !/\s/.test(value);
}

function validBridgeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BRIDGE_ID_LENGTH && !/\s/.test(value);
}

export function isBotRuntimeBinding(value: unknown): value is BotRuntimeBinding {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "provider") {
    if (!validInstanceId(value.instanceId)) return false;
    if (value.model !== undefined && (typeof value.model !== "string" || value.model.length === 0 || value.model.length > 256)) {
      return false;
    }
    return true;
  }
  if (value.kind !== "hermes" || value.bindingVersion !== 2 || !isRecord(value.placement)) return false;
  if (value.placement.kind === "local") return validProfile(value.placement.profile);
  if (value.placement.kind === "bridge") {
    return validBridgeId(value.placement.bridgeId) && validProfile(value.placement.profile);
  }
  return false;
}

export function normalizeLegacyHermesBinding(binding: HermesBotBinding): HermesRuntimeBinding {
  return projectHermesBindingPlacement(binding);
}

function providerBindingFrom(bot: BotRecord): ProviderRuntimeBinding {
  const binding: ProviderRuntimeBinding = { kind: "provider", instanceId: bot.modelSelection.instanceId };
  if (bot.modelSelection.model) binding.model = bot.modelSelection.model;
  return binding;
}

function sidecarFailure(
  result: Extract<BindingStoreResult<unknown>, { state: "unavailable" }>,
): Extract<RuntimeBindingResolution, { state: "unavailable" }> {
  return { state: "unavailable", code: result.code, message: result.message };
}

export function resolveBotRuntimeBinding(bot: BotRecord): RuntimeBindingResolution {
  const local = loadHermesBindings();
  if (local.state === "unavailable") return sidecarFailure(local);
  const remote = loadHermesBridgeBindings();
  if (remote.state === "unavailable") {
    return { state: "unavailable", code: remote.code, message: remote.message };
  }

  if (isBotRuntimeBinding(bot.runtimeBinding)) {
    return { state: "available", value: bot.runtimeBinding };
  }

  const localBinding = local.value.get(bot.id);
  if (localBinding) {
    return { state: "available", value: normalizeLegacyHermesBinding(localBinding) };
  }
  const remoteBinding = remote.value.get(bot.id);
  if (remoteBinding) {
    return {
      state: "available",
      value: {
        kind: "hermes",
        placement: { kind: "bridge", bridgeId: remoteBinding.bridgeId, profile: remoteBinding.profile },
        bindingVersion: 2,
      },
    };
  }
  return { state: "available", value: providerBindingFrom(bot) };
}

function botIsIdle(bot: BotRecord): boolean {
  const activity = bot.activity ?? "idle";
  return activity === "idle" && !bot.busy && !ACTIVITY_BUSY.has(activity);
}

function bindingsEqual(left: BotRuntimeBinding, right: BotRuntimeBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function failure(code: RuntimeRebindFailureCode, message: string): PlanBotRuntimeRebindResult {
  return { ok: false, code, message };
}

function buildHandoffSummary(
  contextMode: "summary" | "none",
  context: Record<string, unknown> | undefined,
): { ok: true; summary: string } | { ok: false; code: "invalid_handoff"; message: string } {
  if (contextMode === "none") return { ok: true, summary: "" };
  const source = context ?? {};
  for (const key of Object.keys(source)) {
    if (isSecretName(key) || FORBIDDEN_HANDOFF_KEYS.test(key)) {
      return { ok: false, code: "invalid_handoff", message: "Context handoff rejected a secret-shaped field" };
    }
  }
  const summaryText = typeof source.summary === "string" ? source.summary.trim() : "";
  const extras = Object.entries(source)
    .filter(([key]) => key !== "summary")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  const combined = [summaryText, ...extras].filter(Boolean).join(" ").trim();
  return { ok: true, summary: combined.slice(0, MAX_HANDOFF_LENGTH) };
}

export function planBotRuntimeRebind(input: PlanBotRuntimeRebindInput): PlanBotRuntimeRebindResult {
  if (!isBotRuntimeBinding(input.requested)) {
    return failure("invalid_binding", "Runtime binding is invalid");
  }
  if (!botIsIdle(input.bot)) {
    return failure("bot_active", "Runtime can change only while the bot is idle");
  }
  const current = resolveBotRuntimeBinding(input.bot);
  if (current.state === "unavailable") {
    return failure("state_unavailable", current.message);
  }
  if (input.requested.kind === "hermes") {
    const endpoint = input.endpoint ?? { state: "missing" as const };
    if (endpoint.state === "unreadable") {
      return failure("endpoint_unreadable", "Hermes endpoint identity is unreadable");
    }
    if (endpoint.state !== "available") {
      return failure("endpoint_unavailable", "Hermes endpoint is unavailable");
    }
  }
  const handoff = buildHandoffSummary(input.contextMode, input.context);
  if (handoff.ok === false) return failure(handoff.code, handoff.message);

  const plan: RuntimeRebindPlan = {
    previous: current.value,
    next: input.requested,
    preservedBotId: input.bot.id,
    handoffSummary: handoff.summary,
    requiresApproval: !bindingsEqual(current.value, input.requested),
  };
  if (input.requested.kind === "hermes" && input.endpoint?.state === "available") {
    plan.expectedCapabilityRevision = input.endpoint.capabilityRevision;
  }
  return { ok: true, plan };
}

function persistSidecars(botId: string, binding: BotRuntimeBinding): void {
  if (binding.kind === "provider") {
    const local = removeHermesBinding(botId);
    if (local.state === "unavailable") throw new RuntimeRebindError("state_unavailable", local.message);
    const remote = removeHermesBridgeBinding(botId);
    if (remote.state === "unavailable") throw new RuntimeRebindError("state_unavailable", remote.message);
    return;
  }
  if (binding.placement.kind === "local") {
    const written = setHermesBinding(botId, {
      adapter: "hermesBot",
      profile: binding.placement.profile,
      canonicalTitle: "Bot Chat",
      bindingVersion: 1,
    });
    if (written.state === "unavailable") throw new RuntimeRebindError("state_unavailable", written.message);
    const remote = removeHermesBridgeBinding(botId);
    if (remote.state === "unavailable") throw new RuntimeRebindError("state_unavailable", remote.message);
    return;
  }
  const written = setHermesBridgeBinding(botId, {
    bridgeId: binding.placement.bridgeId,
    profile: binding.placement.profile,
    bindingVersion: 1,
  });
  if (written.state === "unavailable") throw new RuntimeRebindError("state_unavailable", written.message);
  const local = removeHermesBinding(botId);
  if (local.state === "unavailable") throw new RuntimeRebindError("state_unavailable", local.message);
}

type SidecarSnapshot = {
  local: HermesBotBinding | undefined;
  remote: HermesBridgeBinding | undefined;
};

function snapshotSidecars(botId: string): SidecarSnapshot {
  const local = loadHermesBindings();
  if (local.state === "unavailable") throw new RuntimeRebindError("state_unavailable", local.message);
  const remote = loadHermesBridgeBindings();
  if (remote.state === "unavailable") throw new RuntimeRebindError("state_unavailable", remote.message);
  return { local: local.value.get(botId), remote: remote.value.get(botId) };
}

function restoreSidecars(botId: string, snapshot: SidecarSnapshot): void {
  if (snapshot.local) {
    const written = setHermesBinding(botId, snapshot.local);
    if (written.state === "unavailable") throw new RuntimeRebindError("state_unavailable", written.message);
  } else {
    const removed = removeHermesBinding(botId);
    if (removed.state === "unavailable") throw new RuntimeRebindError("state_unavailable", removed.message);
  }
  if (snapshot.remote) {
    const written = setHermesBridgeBinding(botId, snapshot.remote);
    if (written.state === "unavailable") throw new RuntimeRebindError("state_unavailable", written.message);
  } else {
    const removed = removeHermesBridgeBinding(botId);
    if (removed.state === "unavailable") throw new RuntimeRebindError("state_unavailable", removed.message);
  }
}

function identitiesAgree(bot: BotRecord, expected: BotRuntimeBinding): boolean {
  const resolved = resolveBotRuntimeBinding(bot);
  return resolved.state === "available" && JSON.stringify(resolved.value) === JSON.stringify(expected);
}

export async function applyBotRuntimeRebind(
  plan: RuntimeRebindPlan,
  deps: ApplyBotRuntimeRebindDeps,
): Promise<BotRecord> {
  const bot = deps.store.bot(plan.preservedBotId);
  if (!bot) throw new RuntimeRebindError("bot_not_found", "Bot is unavailable");
  if (!botIsIdle(bot)) throw new RuntimeRebindError("bot_active", "Runtime can change only while the bot is idle");

  if (plan.next.kind === "hermes") {
    const endpoint = deps.endpoint ?? { state: "missing" as const };
    if (endpoint.state === "unreadable") {
      throw new RuntimeRebindError("endpoint_unreadable", "Hermes endpoint identity is unreadable");
    }
    if (endpoint.state !== "available") {
      throw new RuntimeRebindError("endpoint_unavailable", "Hermes endpoint is unavailable");
    }
    if (plan.expectedCapabilityRevision !== undefined && endpoint.capabilityRevision !== plan.expectedCapabilityRevision) {
      throw new RuntimeRebindError("stale_endpoint", "Hermes endpoint capability revision changed");
    }
  }

  const snapshot = snapshotSidecars(bot.id);
  const previousBinding = bot.runtimeBinding;
  const previousModel = bot.modelSelection;
  try {
    persistSidecars(bot.id, plan.next);
    const patch: Partial<BotRecord> = { runtimeBinding: plan.next };
    if (plan.next.kind === "provider") {
      patch.modelSelection = {
        instanceId: plan.next.instanceId,
        model: plan.next.model ?? bot.modelSelection.model,
      };
    }
    const updated = deps.store.patchBot(bot.id, patch);
    if (!updated) throw new RuntimeRebindError("bot_not_found", "Bot is unavailable");
    if (!identitiesAgree(updated, plan.next)) {
      throw new RuntimeRebindError("state_unavailable", "Runtime identity is unavailable");
    }
    return updated;
  } catch (error) {
    try {
      restoreSidecars(bot.id, snapshot);
      if (previousBinding) {
        deps.store.patchBot(bot.id, { runtimeBinding: previousBinding, modelSelection: previousModel });
      } else {
        const current = deps.store.bot(bot.id);
        if (current?.runtimeBinding) {
          deps.store.patchBot(bot.id, { modelSelection: previousModel });
        }
      }
    } catch {
      throw new RuntimeRebindError("state_unavailable", "Runtime identity is unavailable");
    }
    if (error instanceof RuntimeRebindError) throw error;
    throw new RuntimeRebindError("state_unavailable", "Runtime identity is unavailable");
  }
}
