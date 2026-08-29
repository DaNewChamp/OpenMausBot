// Harness-native home-bridge / SSH approval gate.
//
// `/api/internal/bridge/shell` and `/ssh` hold the agent request until a
// human answers — the same options-card flow peer comms already use. A
// missing scoped grant must raise a real pending card on the asking bot's
// thread (so the existing phone always-allow path can see it). Logging
// `card-shown` without a card is a lie; this module is the thing that
// makes the row true.
//
// Auto mode never inherits. Always-allow is the existing program-scoped
// key (`bridge:run_on_bridge:<program>`). One-shot Allow is bound to the
// exact bot, target, command, cwd, and expiry so a stale or altered
// request cannot reuse it.

import { createHash } from "node:crypto";

import { approvalKey, autoVerdict, looksDestructive, looksSensitive } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { appendDecision } from "./decision-log.ts";
import { buildNotification } from "./notify.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import type { BotRecord, Message } from "./store.ts";

export type { ApprovalBus } from "./peer-approval.ts";

export type BridgeApprovalTool = "run_on_bridge" | "run_on_ssh_target";

export interface BridgeApprovalRequest {
  bot: BotRecord;
  tool: BridgeApprovalTool;
  command: string;
  /** Bridge id/name, or the SSH target alias. */
  target: string;
  cwd?: string;
  /** Decision-log thread (the source turn). The card still lives on `bot.threadId`. */
  logThreadId?: string;
  /** Test seam — production uses 15 minutes, matching peer approvals. */
  timeoutMs?: number;
}

const APPROVAL_TIMEOUT_MS = 15 * 60_000;
const SETTLED_TTL_MS = 60_000;

interface Pending {
  waiters: Array<(result: "allow" | "deny") => void>;
  timer: ReturnType<typeof setTimeout>;
  botId: string;
  tool: BridgeApprovalTool;
  command: string;
  fingerprint: string;
  expiresAt: number;
  threadId: string;
  logThreadId: string;
  messageId: string;
  requestId: string;
  bus: ApprovalBus;
}

const pendingById = new Map<string, Pending>();
const pendingByFingerprint = new Map<string, Pending>();
const recentlySettled = new Map<string, ReturnType<typeof setTimeout>>();

function fingerprintOf(input: {
  botId: string;
  tool: BridgeApprovalTool;
  target: string;
  command: string;
  cwd?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        botId: input.botId,
        tool: input.tool,
        target: input.target,
        command: input.command,
        cwd: input.cwd ?? "",
      }),
    )
    .digest("hex");
}

function settleCard(pending: Pending, behavior: string, source: "user" | "system"): void {
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
}

function rememberSettled(requestId: string): void {
  const prev = recentlySettled.get(requestId);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => recentlySettled.delete(requestId), SETTLED_TTL_MS);
  timer.unref?.();
  recentlySettled.set(requestId, timer);
}

function settlePending(pending: Pending, result: "allow" | "deny", source: "user" | "system"): void {
  pendingById.delete(pending.requestId);
  if (pendingByFingerprint.get(pending.fingerprint) === pending) {
    pendingByFingerprint.delete(pending.fingerprint);
  }
  clearTimeout(pending.timer);
  rememberSettled(pending.requestId);
  settleCard(pending, result, source);
  if (source === "user") {
    const live = pending.bus.store.bot(pending.botId);
    appendDecision(DATA_DIR, {
      threadId: pending.logThreadId,
      requestId: pending.requestId,
      botId: pending.botId,
      botName: live?.name,
      tool: pending.tool,
      summary: pending.command.slice(0, 240),
      decision: result === "allow" ? "user-approved" : "user-denied",
      source: "user",
    });
  }
  for (const waiter of pending.waiters) waiter(result);
}

function joinPending(pending: Pending): Promise<"allow" | "deny"> {
  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

function grantBlocked(command: string, tool: string): boolean {
  return looksDestructive(command) || looksDestructive(tool) || looksSensitive(command);
}

function pushApprovalCard(
  bus: ApprovalBus,
  bot: BotRecord,
  req: BridgeApprovalRequest,
  requestId: string,
  allowKey: string | undefined,
): Message {
  const targetLabel = req.target.trim() || (req.tool === "run_on_ssh_target" ? "an SSH target" : "a home bridge");
  const title =
    req.tool === "run_on_ssh_target"
      ? `@${bot.name} wants to SSH to ${targetLabel}`
      : `@${bot.name} wants to run on ${targetLabel}`;
  const subtitle = req.command.length > 200 ? `${req.command.slice(0, 200)}…` : req.command;
  return bus.store.appendMessage(bot.threadId, {
    role: "bot",
    kind: "options",
    card: {
      title,
      subtitle,
      options: allowKey ? ["Allow", "Deny", "Always allow"] : ["Allow", "Deny"],
      requestId,
      tool: req.tool,
      ...(allowKey ? { allowKey } : {}),
    },
  });
}

/** Ask the user whether this bot may run this exact command on this target. */
export function requestBridgeApproval(
  bus: ApprovalBus,
  req: BridgeApprovalRequest,
): Promise<"allow" | "deny"> {
  const live = bus.store.bot(req.bot.id) ?? req.bot;
  const logThreadId = req.logThreadId || live.threadId;
  const verdict = autoVerdict(live, req.tool, req.command, { scope: "bridge" });
  if (verdict.approve) {
    appendDecision(DATA_DIR, {
      threadId: logThreadId,
      botId: live.id,
      botName: live.name,
      tool: req.tool,
      summary: req.command.slice(0, 240),
      decision: "auto-approved",
      source: verdict.source,
      rule: verdict.rule,
    });
    return Promise.resolve("allow");
  }

  const fingerprint = fingerprintOf({
    botId: live.id,
    tool: req.tool,
    target: req.target,
    command: req.command,
    cwd: req.cwd,
  });
  const existing = pendingByFingerprint.get(fingerprint);
  if (existing) {
    if (Date.now() < existing.expiresAt) return joinPending(existing);
    settlePending(existing, "deny", "system");
  }

  const timeoutMs = req.timeoutMs ?? APPROVAL_TIMEOUT_MS;
  const requestId = newId();
  const allowKey = grantBlocked(req.command, req.tool) ? undefined : approvalKey(req.tool, req.command, "bridge");
  const card = pushApprovalCard(bus, live, req, requestId, allowKey);
  appendDecision(DATA_DIR, {
    threadId: logThreadId,
    requestId,
    botId: live.id,
    botName: live.name,
    tool: req.tool,
    summary: req.command.slice(0, 240),
    decision: "card-shown",
    source: verdict.source,
    rule: verdict.rule,
  });
  const notification = buildNotification("approval", live, live.threadId, req.command);
  if (notification) bus.broadcast({ kind: "notify", notification });

  return new Promise((resolve) => {
    const pending: Pending = {
      waiters: [resolve],
      timer: setTimeout(() => {
        const still = pendingById.get(requestId);
        if (!still) return;
        settlePending(still, "deny", "system");
      }, timeoutMs),
      botId: live.id,
      tool: req.tool,
      command: req.command,
      fingerprint,
      expiresAt: Date.now() + timeoutMs,
      threadId: live.threadId,
      logThreadId,
      messageId: card.id,
      requestId,
      bus,
    };
    pending.timer.unref?.();
    pendingById.set(requestId, pending);
    pendingByFingerprint.set(fingerprint, pending);
  });
}

/** Called by the respond endpoints BEFORE forwarding to the provider adapter. */
export function resolveBridgeApproval(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
): boolean {
  const pending = pendingById.get(requestId);
  if (!pending) return recentlySettled.has(requestId);
  if (Date.now() >= pending.expiresAt) {
    settlePending(pending, "deny", "system");
    return true;
  }
  settlePending(pending, behavior === "allow" ? "allow" : "deny", "user");
  return true;
}

export function cancelBridgeApprovalsFor(botId: string): void {
  for (const pending of [...pendingById.values()]) {
    if (pending.botId !== botId) continue;
    settlePending(pending, "deny", "system");
  }
}

export function cancelBridgeApprovalsForThread(threadId: string): void {
  for (const pending of [...pendingById.values()]) {
    if (pending.threadId !== threadId && pending.logThreadId !== threadId) continue;
    settlePending(pending, "deny", "system");
  }
}

export function dismissStaleBridgeCards(bus: ApprovalBus): number {
  let dismissed = 0;
  for (const bot of bus.store.bots) {
    const threadIds = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
    for (const threadId of threadIds) {
      for (const message of bus.store.messagesFor(threadId)) {
        const card = message.card;
        if (!card?.requestId || card.answered || card.dismissed) continue;
        if (card.tool !== "run_on_bridge" && card.tool !== "run_on_ssh_target") continue;
        if (pendingById.has(card.requestId)) continue;
        const patched = bus.store.patchMessage(threadId, message.id, {
          card: { ...card, answered: "deny", dismissed: true },
        });
        if (patched) dismissed += 1;
      }
    }
  }
  return dismissed;
}

/** Test-only: drop in-flight waiters so a suite cannot leak timers. */
export function resetBridgeApprovalsForTests(): void {
  for (const pending of pendingById.values()) clearTimeout(pending.timer);
  pendingById.clear();
  pendingByFingerprint.clear();
  for (const timer of recentlySettled.values()) clearTimeout(timer);
  recentlySettled.clear();
}
