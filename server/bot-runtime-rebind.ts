import { createHash } from "node:crypto";

import { newId } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import {
  applyBotRuntimeRebind,
  isBotRuntimeBinding,
  planBotRuntimeRebind,
  RuntimeRebindError,
  type BotRuntimeBinding,
  type RuntimeEndpointState,
  type RuntimeRebindPlan,
  type RuntimeRebindRequest,
} from "./bot-runtime-binding.ts";
import type { BotRecord, Store } from "./store.ts";

export {
  resolveBotRuntimeBinding,
  type BotRuntimeBinding,
  type RuntimeRebindRequest,
} from "./bot-runtime-binding.ts";

const endpoints = new Map<string, { revision: string; status: "available" | "unreadable" }>();
const bridgeAliases = new Map<string, string>();
const pendingRebinds = new Map<
  string,
  {
    fingerprint: string;
    plan: RuntimeRebindPlan;
    threadId: string;
    messageId: string;
  }
>();

export type RuntimeRebindResult =
  | {
      status: "applied";
      bot: BotRecord;
      summary: string;
      restartRequired: boolean;
      fingerprint: string;
    }
  | {
      status: "pending_approval";
      requestId: string;
      fingerprint: string;
      summary: string;
      restartRequired: boolean;
    }
  | {
      status: "error";
      code: string;
      message: string;
    };

export type RequestBotRuntimeRebindInput = {
  store: Store;
  request: RuntimeRebindRequest;
  actor?: BotRecord | null;
  approval?: ApprovalBus;
  context?: Record<string, unknown>;
  endpoint?: RuntimeEndpointState;
  endpointError?: string;
};

export function hermesEndpointId(binding: BotRuntimeBinding): string {
  if (binding.kind === "provider") return `provider:${binding.instanceId}`;
  if (binding.placement.kind === "local") return `local:${binding.placement.profile.toLowerCase()}`;
  return `bridge:${binding.placement.bridgeId}:${binding.placement.profile.toLowerCase()}`;
}

export function rememberHermesEndpoint(
  endpointId: string,
  capabilityRevision: string,
  status: "available" | "unreadable" = "available",
): void {
  endpoints.set(endpointId, { revision: capabilityRevision, status });
}

export function rememberHermesBridgeAlias(label: string, bridgeId: string): void {
  const key = label.trim().toLowerCase();
  const canonical = bridgeId.trim();
  if (!key || !canonical) return;
  bridgeAliases.set(key, canonical);
}

export function canonicalizeBotRuntimeBinding(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.kind !== "hermes" || !record.placement || typeof record.placement !== "object" || Array.isArray(record.placement)) {
    return value;
  }
  const placement = record.placement as Record<string, unknown>;
  if (placement.kind !== "bridge" || typeof placement.bridgeId !== "string") return value;
  const alias = bridgeAliases.get(placement.bridgeId.trim().toLowerCase());
  if (!alias || alias === placement.bridgeId) return value;
  return {
    ...record,
    placement: { ...placement, bridgeId: alias },
  };
}

export function rememberLocalHermesProfiles(
  profiles: Array<{ profile?: string; availability?: string }>,
  capabilityRevision: string,
): void {
  for (const row of profiles) {
    const profile = typeof row.profile === "string" ? row.profile.trim().toLowerCase() : "";
    if (!profile || row.availability === "unavailable" || row.availability === "unreadable") continue;
    rememberHermesEndpoint(`local:${profile}`, capabilityRevision);
  }
}

export function resetRememberedHermesEndpointsForTests(): void {
  endpoints.clear();
  bridgeAliases.clear();
}

export function lookupHermesEndpoint(binding: BotRuntimeBinding): RuntimeEndpointState {
  if (binding.kind === "provider") {
    return { state: "available", endpointId: hermesEndpointId(binding), capabilityRevision: "provider" };
  }
  const canonical = canonicalizeBotRuntimeBinding(binding);
  const resolved = isBotRuntimeBinding(canonical) ? canonical : binding;
  if (resolved.kind === "provider") {
    return { state: "available", endpointId: hermesEndpointId(resolved), capabilityRevision: "provider" };
  }
  const id = hermesEndpointId(resolved);
  const known = endpoints.get(id) ?? endpoints.get(hermesEndpointId(binding));
  if (!known) return { state: "missing" };
  if (known.status === "unreadable") return { state: "unreadable", endpointId: id };
  return { state: "available", endpointId: id, capabilityRevision: known.revision };
}

export function runtimeBindingFingerprint(binding: BotRuntimeBinding): string {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

function redactPublicText(value: string): string {
  let out = redactSecretsInText(value);
  out = out.replace(/HERMES_HOME(?:=[^\s]*)?/gi, "HERMES_HOME");
  out = out.replace(/(?:\/[\w.-]+)+/g, "[path]");
  return out;
}

function publicError(code: string, message: string, extra?: string): RuntimeRebindResult {
  const combined = extra ? `${message}` : message;
  return { status: "error", code, message: redactPublicText(combined) };
}

function describeBinding(binding: BotRuntimeBinding): string {
  if (binding.kind === "provider") {
    const engine = binding.instanceId.charAt(0).toUpperCase() + binding.instanceId.slice(1);
    return binding.model ? `${engine} (${binding.model})` : engine;
  }
  if (binding.placement.kind === "local") {
    return `local Hermes profile ${binding.placement.profile}`;
  }
  const computer = binding.placement.bridgeId.replace(/^bridge-/, "").replace(/-/g, " ");
  return `${computer} / ${binding.placement.profile}`;
}

function conversionSummary(bot: BotRecord, plan: RuntimeRebindPlan, pending: boolean): string {
  const verb = pending ? "Convert" : "Converted";
  const restart = plan.previous.kind !== plan.next.kind ? " A restart is required." : "";
  const wait = pending ? " Waiting for your approval." : "";
  return redactPublicText(
    `${verb} ${bot.name} from ${describeBinding(plan.previous)} to ${describeBinding(plan.next)}. Bot id, name, rooms, and history stay the same.${restart}${wait}`,
  );
}

function settleCard(bus: ApprovalBus, threadId: string, messageId: string, behavior: string): void {
  const existing = bus.store.messagesFor(threadId).find((message) => message.id === messageId);
  if (!existing?.card || existing.card.answered) return;
  bus.store.patchMessage(threadId, messageId, {
    card: { ...existing.card, answered: behavior, dismissed: false },
  });
}

export async function requestBotRuntimeRebind(input: RequestBotRuntimeRebindInput): Promise<RuntimeRebindResult> {
  const bot = input.store.bot(input.request.targetBotId);
  if (!bot) return publicError("bot_not_found", "Bot is unavailable");
  const binding = canonicalizeBotRuntimeBinding(input.request.binding);
  if (!isBotRuntimeBinding(binding)) {
    return publicError("invalid_binding", "Runtime binding is invalid");
  }

  const endpoint = input.endpoint ?? lookupHermesEndpoint(binding);
  if (binding.kind === "hermes" && endpoint.state !== "available") {
    const code = endpoint.state === "unreadable" ? "endpoint_unreadable" : "endpoint_unavailable";
    if (input.endpointError) {
      return publicError(code, "Hermes endpoint is unavailable", input.endpointError);
    }
    return publicError(code, endpoint.state === "unreadable" ? "Hermes endpoint identity is unreadable" : "Hermes endpoint is unavailable");
  }

  const planned = planBotRuntimeRebind({
    bot,
    requested: binding,
    contextMode: input.request.contextMode,
    context: input.context,
    endpoint,
  });
  if (planned.ok !== true) {
    return publicError(planned.code, planned.message);
  }

  const fingerprint = runtimeBindingFingerprint(planned.plan.next);
  const restartRequired = planned.plan.previous.kind !== planned.plan.next.kind;

  if (!input.request.userRequested) {
    const actor = input.actor ?? null;
    if (!actor || !input.approval) {
      return publicError("invalid_binding", "Autonomous runtime changes require an accountable requester");
    }
    const requestId = newId();
    const summary = conversionSummary(bot, planned.plan, true);
    const card = input.approval.store.appendMessage(actor.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: `${actor.name} needs your approval`,
        subtitle: summary,
        reason: "Hermes asked to change this bot's runtime. Nothing changes unless you approve.",
        actionSummary: summary,
        details: summary,
        toolLabel: "Runtime conversion",
        hostLabel: describeBinding(planned.plan.next),
        options: ["Allow", "Deny"],
        requestId,
        tool: "configure_bot_runtime",
      },
    });
    pendingRebinds.set(requestId, {
      fingerprint,
      plan: planned.plan,
      threadId: actor.threadId,
      messageId: card.id,
    });
    input.approval.broadcast({ kind: "message", threadId: actor.threadId, message: card });
    return { status: "pending_approval", requestId, fingerprint, summary, restartRequired };
  }

  try {
    const updated = await applyBotRuntimeRebind(planned.plan, { store: input.store, endpoint });
    return {
      status: "applied",
      bot: updated,
      summary: conversionSummary(updated, planned.plan, false),
      restartRequired,
      fingerprint,
    };
  } catch (error) {
    const code = error instanceof RuntimeRebindError ? error.code : "state_unavailable";
    const message = error instanceof Error ? error.message : "Runtime rebind failed";
    return publicError(code, message);
  }
}

export type ResolveRuntimeRebindResult =
  | { handled: false }
  | { handled: true; ok: true }
  | { handled: true; ok: false; code: string; message: string };

export function replacePendingRuntimeRebindForTests(
  requestId: string,
  patch: { fingerprint?: string; plan?: RuntimeRebindPlan },
): boolean {
  const pending = pendingRebinds.get(requestId);
  if (!pending) return false;
  pendingRebinds.set(requestId, { ...pending, ...patch });
  return true;
}

export async function resolveRuntimeRebind(
  bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): Promise<ResolveRuntimeRebindResult> {
  const pending = pendingRebinds.get(requestId);
  if (!pending) return { handled: false };
  const allow = behavior === "allow";
  if (!allow) {
    pendingRebinds.delete(requestId);
    settleCard(bus, pending.threadId, pending.messageId, "deny");
    return { handled: true, ok: true };
  }
  if (runtimeBindingFingerprint(pending.plan.next) !== pending.fingerprint) {
    return publicResolveError("invalid_binding", "Runtime conversion request no longer matches the approved binding");
  }
  const endpoint = lookupHermesEndpoint(pending.plan.next);
  try {
    await applyBotRuntimeRebind(pending.plan, { store: bus.store, endpoint });
  } catch (error) {
    const code = error instanceof RuntimeRebindError ? error.code : "state_unavailable";
    const message = error instanceof Error ? error.message : "Runtime rebind failed";
    return publicResolveError(code, message);
  }
  pendingRebinds.delete(requestId);
  settleCard(bus, pending.threadId, pending.messageId, "allow");
  return { handled: true, ok: true };
}

function publicResolveError(code: string, message: string): ResolveRuntimeRebindResult {
  return { handled: true, ok: false, code, message: redactPublicText(message) };
}
