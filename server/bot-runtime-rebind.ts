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

export function lookupHermesEndpoint(binding: BotRuntimeBinding): RuntimeEndpointState {
  if (binding.kind === "provider") {
    return { state: "available", endpointId: hermesEndpointId(binding), capabilityRevision: "provider" };
  }
  const id = hermesEndpointId(binding);
  const known = endpoints.get(id);
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
  if (!isBotRuntimeBinding(input.request.binding)) {
    return publicError("invalid_binding", "Runtime binding is invalid");
  }

  const endpoint = input.endpoint ?? lookupHermesEndpoint(input.request.binding);
  if (input.request.binding.kind === "hermes" && endpoint.state !== "available") {
    const code = endpoint.state === "unreadable" ? "endpoint_unreadable" : "endpoint_unavailable";
    if (input.endpointError) {
      return publicError(code, "Hermes endpoint is unavailable", input.endpointError);
    }
    return publicError(code, endpoint.state === "unreadable" ? "Hermes endpoint identity is unreadable" : "Hermes endpoint is unavailable");
  }

  const planned = planBotRuntimeRebind({
    bot,
    requested: input.request.binding,
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

export function resolveRuntimeRebind(bus: ApprovalBus, requestId: string, behavior: string | undefined): boolean {
  const pending = pendingRebinds.get(requestId);
  if (!pending) return false;
  pendingRebinds.delete(requestId);
  const allow = behavior === "allow";
  settleCard(bus, pending.threadId, pending.messageId, allow ? "allow" : "deny");
  if (!allow) return true;
  if (runtimeBindingFingerprint(pending.plan.next) !== pending.fingerprint) return true;
  const endpoint = lookupHermesEndpoint(pending.plan.next);
  void applyBotRuntimeRebind(pending.plan, { store: bus.store, endpoint }).catch(() => {
    // Failure stays on the bot record; the card is already settled.
  });
  return true;
}
