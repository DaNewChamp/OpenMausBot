// Harness-native home-bridge / SSH approval gate.
//
// `/api/internal/bridge/shell` and `/ssh` hold the agent request until a
// human answers — the same options-card flow peer comms already use. The
// concrete bridge ID is resolved BEFORE a card exists, so fingerprint,
// title, and execution all name that bridge. Joined HTTP callers share
// one execution. A disconnected requester cannot be Allowed later.
//
// Auto mode never inherits. Always-allow is the existing program-scoped
// key (`bridge:run_on_bridge:<program>`). One-shot Allow is bound to the
// exact bot, bridge id, command, cwd, run timeout, SSH alias, and expiry.

import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";

import { approvalKey, autoVerdict, looksDestructive, looksSensitive } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { appendDecision } from "./decision-log.ts";
import { buildNotification } from "./notify.ts";
import { sanitizeLocalVmInvokeText } from "./local-vm-invoke.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import type { BotRecord, Message } from "./store.ts";

export type { ApprovalBus } from "./peer-approval.ts";

export type BridgeApprovalTool = "run_on_bridge" | "run_on_ssh_target";

export type BridgeApprovalOutcome = "allowed-once" | "rejected" | "expired" | "forbidden";

export type BridgeApprovalResolve = { handled: false } | { handled: true; outcome: BridgeApprovalOutcome };

export type BridgeRunDecision<T> =
  | { outcome: "allow"; result: T }
  | { outcome: "deny" }
  | { outcome: "expired" };

export interface BridgeApprovalRequest<T> {
  bot: BotRecord;
  tool: BridgeApprovalTool;
  command: string;
  /** Exact resolved bridge id — required before a card is created. */
  bridgeId: string;
  bridgeName: string;
  /** SSH config alias on the jump bridge, when tool is run_on_ssh_target. */
  sshAlias?: string;
  cwd?: string;
  /** Command execution timeout; part of the one-shot fingerprint. */
  runTimeoutMs?: number;
  /** Decision-log thread (the source turn). The card still lives on `bot.threadId`. */
  logThreadId?: string;
  /** Test / env seam — production uses 15 minutes, matching peer approvals. */
  approvalTimeoutMs?: number;
  /** Disconnecting the HTTP requester aborts this waiter. */
  signal?: AbortSignal;
  /** Run exactly once for all joined waiters after allow / always-allow. */
  execute: () => Promise<T>;
}

const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const APPROVAL_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.OMB_BRIDGE_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 15 * 60_000;
})();
const SETTLED_TTL_MS = 60_000;

type Waiter<T> = {
  resolve: (result: BridgeRunDecision<T>) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

interface Pending<T = unknown> {
  waiters: Array<Waiter<T>>;
  timer: ReturnType<typeof setTimeout>;
  botId: string;
  threadId: string;
  tool: BridgeApprovalTool;
  command: string;
  fingerprint: string;
  expiresAt: number;
  logThreadId: string;
  messageId?: string;
  requestId: string;
  bus: ApprovalBus;
  execute: () => Promise<T>;
  execution?: Promise<T>;
  settled?: "allow" | "deny" | "expired";
}

interface Settled {
  outcome: Exclude<BridgeApprovalOutcome, "forbidden">;
  botId: string;
  threadId: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingById = new Map<string, Pending<any>>();
const pendingByFingerprint = new Map<string, Pending<any>>();
const recentlySettled = new Map<string, Settled>();

function fingerprintOf(input: {
  botId: string;
  tool: BridgeApprovalTool;
  bridgeId: string;
  sshAlias?: string;
  command: string;
  cwd?: string;
  runTimeoutMs?: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        botId: input.botId,
        tool: input.tool,
        bridgeId: input.bridgeId,
        sshAlias: input.sshAlias ?? "",
        command: input.command,
        cwd: input.cwd ?? "",
        runTimeoutMs: input.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      }),
    )
    .digest("hex");
}

function settleCard(pending: Pending<any>, behavior: string, source: "user" | "system"): void {
  if (!pending.messageId) return;
  const existing = pending.bus.store
    .messagesFor(pending.threadId)
    .find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  pending.bus.store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: behavior, dismissed: source !== "user" },
  });
}

function rememberSettled(pending: Pending<any>, outcome: Exclude<BridgeApprovalOutcome, "forbidden">): void {
  const prev = recentlySettled.get(pending.requestId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => recentlySettled.delete(pending.requestId), SETTLED_TTL_MS);
  timer.unref?.();
  recentlySettled.set(pending.requestId, {
    outcome,
    botId: pending.botId,
    threadId: pending.threadId,
    timer,
  });
}

function detachWaiter<T>(pending: Pending<T>, waiter: Waiter<T>): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  pending.waiters = pending.waiters.filter((entry) => entry !== waiter);
}

function finishWaiters<T>(pending: Pending<T>, result: BridgeRunDecision<T>): void {
  const waiters = pending.waiters.splice(0);
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(result);
  }
}

function rejectWaiters<T>(pending: Pending<T>, error: unknown): void {
  const waiters = pending.waiters.splice(0);
  for (const waiter of waiters) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
}

function dropFingerprint(pending: Pending<any>): void {
  pendingById.delete(pending.requestId);
  if (pendingByFingerprint.get(pending.fingerprint) === pending) {
    pendingByFingerprint.delete(pending.fingerprint);
  }
  clearTimeout(pending.timer);
}

function settleDeny<T>(pending: Pending<T>, source: "user" | "system", kind: "deny" | "expired"): void {
  if (pending.settled) return;
  pending.settled = kind === "expired" ? "expired" : "deny";
  dropFingerprint(pending);
  rememberSettled(pending, kind === "expired" ? "expired" : "rejected");
  settleCard(pending, "deny", source);
  if (source === "user") {
    const live = pending.bus.store.bot(pending.botId);
    appendDecision(DATA_DIR, {
      threadId: pending.logThreadId,
      requestId: pending.requestId,
      botId: pending.botId,
      botName: live?.name,
      tool: pending.tool,
      summary: pending.command.slice(0, 240),
      decision: "user-denied",
      source: "user",
    });
  }
  finishWaiters(pending, { outcome: kind === "expired" ? "expired" : "deny" });
}

async function settleAllow<T>(pending: Pending<T>, source: "user" | "system"): Promise<void> {
  if (pending.settled) return;
  pending.settled = "allow";
  pendingById.delete(pending.requestId);
  clearTimeout(pending.timer);
  // The live respond already returned allowed-once. A later Allow on this
  // consumed requestId is rejected, never allowed-once again.
  rememberSettled(pending, "rejected");
  settleCard(pending, "allow", source);
  if (source === "user") {
    const live = pending.bus.store.bot(pending.botId);
    appendDecision(DATA_DIR, {
      threadId: pending.logThreadId,
      requestId: pending.requestId,
      botId: pending.botId,
      botName: live?.name,
      tool: pending.tool,
      summary: pending.command.slice(0, 240),
      decision: "user-approved",
      source: "user",
    });
  }
  try {
    pending.execution ??= pending.execute();
    const result = await pending.execution;
    if (pendingByFingerprint.get(pending.fingerprint) === pending) {
      pendingByFingerprint.delete(pending.fingerprint);
    }
    finishWaiters(pending, { outcome: "allow", result });
  } catch (error) {
    if (pendingByFingerprint.get(pending.fingerprint) === pending) {
      pendingByFingerprint.delete(pending.fingerprint);
    }
    rejectWaiters(pending, error);
  }
}

function ownerMatches(
  pending: { botId: string; threadId: string },
  owner?: { botId?: string; threadId?: string },
): boolean {
  if (owner?.botId && owner.botId !== pending.botId) return false;
  if (owner?.threadId && owner.threadId !== pending.threadId) return false;
  return true;
}

function grantBlocked(command: string, tool: string): boolean {
  return looksDestructive(command) || looksDestructive(tool) || looksSensitive(command);
}

function pushApprovalCard(
  bus: ApprovalBus,
  bot: BotRecord,
  req: BridgeApprovalRequest<unknown>,
  requestId: string,
  allowKey: string | undefined,
): Message {
  // The bridge id is an internal routing fingerprint, not a user-facing
  // detail. Keep it in the approval key and execution closure, never in the
  // transcript where it adds noise and leaks host internals to the phone.
  const hostLabel = req.tool === "run_on_ssh_target"
    ? `SSH target ${req.sshAlias || "target"}`
    : req.bridgeName || "computer";
  const readOnly = !looksDestructive(req.command) && !looksSensitive(req.command);
  const actionSummary = `${readOnly ? "Run a read-only command" : "Run a command"} on ${hostLabel}`;
  const safeCommand = sanitizeLocalVmInvokeText(req.command).slice(0, 16_000);
  const subtitle = safeCommand.length > 200 ? `${safeCommand.slice(0, 200)}…` : safeCommand;
  return bus.store.appendMessage(bot.threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `${bot.name} needs your approval`,
      subtitle,
      actionSummary,
      details: subtitle,
      toolLabel: "Terminal",
      hostLabel,
      options: allowKey ? ["Allow", "Deny", "Always allow"] : ["Allow", "Deny"],
      requestId,
      tool: req.tool,
      ...(allowKey ? { allowKey } : {}),
    },
  });
}

function attachWaiter<T>(pending: Pending<T>, signal: AbortSignal | undefined): Promise<BridgeRunDecision<T>> {
  return new Promise((resolve, reject) => {
    const waiter: Waiter<T> = { resolve, reject, signal };
    const onAbort = () => {
      detachWaiter(pending, waiter);
      resolve({ outcome: "deny" });
      if (!pending.settled && !pending.execution && pending.waiters.length === 0) {
        settleDeny(pending, "system", "deny");
      }
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (signal) {
      waiter.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    pending.waiters.push(waiter);
  });
}

function startPending<T>(
  bus: ApprovalBus,
  live: BotRecord,
  req: BridgeApprovalRequest<T>,
  fingerprint: string,
  logThreadId: string,
  withCard: boolean,
  verdictSource: ReturnType<typeof autoVerdict>["source"],
  verdictRule: ReturnType<typeof autoVerdict>["rule"],
): Pending<T> {
  const timeoutMs = req.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  const requestId = newId();
  const allowKey = grantBlocked(req.command, req.tool) ? undefined : approvalKey(req.tool, req.command, "bridge");
  const card = withCard ? pushApprovalCard(bus, live, req, requestId, allowKey) : undefined;
  if (withCard) {
    appendDecision(DATA_DIR, {
      threadId: logThreadId,
      requestId,
      botId: live.id,
      botName: live.name,
      tool: req.tool,
      summary: req.command.slice(0, 240),
      decision: "card-shown",
      source: verdictSource,
      rule: verdictRule,
    });
    const notification = buildNotification("approval", live, live.threadId, req.command);
    if (notification) bus.broadcast({ kind: "notify", notification });
  } else {
    appendDecision(DATA_DIR, {
      threadId: logThreadId,
      botId: live.id,
      botName: live.name,
      tool: req.tool,
      summary: req.command.slice(0, 240),
      decision: "auto-approved",
      source: verdictSource,
      rule: verdictRule,
    });
  }
  const pending: Pending<T> = {
    waiters: [],
    timer: setTimeout(() => {
      const still = pendingById.get(requestId) as Pending<T> | undefined;
      if (!still || still.settled) return;
      settleDeny(still, "system", "expired");
    }, timeoutMs),
    botId: live.id,
    threadId: live.threadId,
    tool: req.tool,
    command: req.command,
    fingerprint,
    expiresAt: Date.now() + timeoutMs,
    logThreadId,
    messageId: card?.id,
    requestId,
    bus,
    execute: req.execute,
  };
  pending.timer.unref?.();
  if (withCard) pendingById.set(requestId, pending);
  pendingByFingerprint.set(fingerprint, pending);
  return pending;
}

/** Ask the user whether this bot may run this exact command on this resolved bridge. */
export function requestBridgeApproval<T>(
  bus: ApprovalBus,
  req: BridgeApprovalRequest<T>,
): Promise<BridgeRunDecision<T>> {
  if (!req.bridgeId.trim()) return Promise.reject(new Error("bridgeId required"));
  const live = bus.store.bot(req.bot.id) ?? req.bot;
  const logThreadId = req.logThreadId || live.threadId;
  const fingerprint = fingerprintOf({
    botId: live.id,
    tool: req.tool,
    bridgeId: req.bridgeId,
    sshAlias: req.sshAlias,
    command: req.command,
    cwd: req.cwd,
    runTimeoutMs: req.runTimeoutMs,
  });
  const existing = pendingByFingerprint.get(fingerprint) as Pending<T> | undefined;
  if (existing) {
    if (!existing.settled && Date.now() >= existing.expiresAt) {
      settleDeny(existing, "system", "expired");
    } else if (!existing.settled || existing.execution) {
      return attachWaiter(existing, req.signal);
    }
  }

  const verdict = autoVerdict(live, req.tool, req.command, { scope: "bridge" });
  if (verdict.approve) {
    const pending = startPending(bus, live, req, fingerprint, logThreadId, false, verdict.source, verdict.rule);
    const waiting = attachWaiter(pending, req.signal);
    void settleAllow(pending, "system");
    return waiting;
  }

  const pending = startPending(bus, live, req, fingerprint, logThreadId, true, verdict.source, verdict.rule);
  return attachWaiter(pending, req.signal);
}

/** Abort this waiter when the HTTP client disconnects before the response is written. */
export function abortSignalFromHttp(res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  const abort = () => {
    if (!res.writableEnded) ac.abort();
  };
  // The request readable may already have ended (body consumed) before we
  // start waiting on the card. The response/socket close is the disconnect.
  res.on("close", abort);
  return ac.signal;
}

/** Called by the respond endpoints BEFORE forwarding to the provider adapter. */
export function resolveBridgeApproval(
  _bus: ApprovalBus,
  requestId: string,
  behavior: string | undefined,
  owner?: { botId?: string; threadId?: string },
): BridgeApprovalResolve {
  const pending = pendingById.get(requestId);
  if (pending) {
    if (!ownerMatches(pending, owner)) return { handled: true, outcome: "forbidden" };
    if (pending.settled) {
      return { handled: true, outcome: pending.settled === "allow" ? "allowed-once" : pending.settled === "expired" ? "expired" : "rejected" };
    }
    if (Date.now() >= pending.expiresAt) {
      settleDeny(pending, "system", "expired");
      return { handled: true, outcome: "expired" };
    }
    if (behavior === "allow") {
      void settleAllow(pending, "user");
      return { handled: true, outcome: "allowed-once" };
    }
    settleDeny(pending, "user", "deny");
    return { handled: true, outcome: "rejected" };
  }
  const settled = recentlySettled.get(requestId);
  if (!settled) return { handled: false };
  if (!ownerMatches(settled, owner)) return { handled: true, outcome: "forbidden" };
  return { handled: true, outcome: settled.outcome };
}

export function cancelBridgeApprovalsFor(botId: string): void {
  for (const pending of [...pendingById.values()]) {
    if (pending.botId !== botId) continue;
    settleDeny(pending, "system", "deny");
  }
}

export function cancelBridgeApprovalsForThread(threadId: string): void {
  for (const pending of [...pendingById.values()]) {
    if (pending.threadId !== threadId && pending.logThreadId !== threadId) continue;
    settleDeny(pending, "system", "deny");
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
  for (const pending of [...pendingById.values(), ...pendingByFingerprint.values()]) {
    clearTimeout(pending.timer);
    if (!pending.settled) pending.settled = "deny";
    finishWaiters(pending, { outcome: "deny" });
  }
  pendingById.clear();
  pendingByFingerprint.clear();
  for (const settled of recentlySettled.values()) clearTimeout(settled.timer);
  recentlySettled.clear();
}
