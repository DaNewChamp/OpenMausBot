import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { resetHermesProjectionStoreForTests } from "./hermes-agent-projection.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Hermes agent projection", () => {
  beforeEach(() => {
    resetHermesProjectionStoreForTests();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    resetHermesProjectionStoreForTests();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("projects a named persistent Hermes agent to one stable V Bot", async () => {
    const { projectHermesAgent } = await import("./hermes-agent-projection.ts");
    const store = new Store(selection);
    const parent = store.createBot({ name: "Chief" }, { seedMessages: false });
    const first = projectHermesAgent(store, {
      hermesAgentId: "hermes-researcher",
      kind: "persistent",
      name: "Researcher",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    const second = projectHermesAgent(store, {
      hermesAgentId: "hermes-researcher",
      kind: "persistent",
      name: "Researcher",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    expect(first.event.type).toBe("subagent.started");
    expect(second.event.type).toBe("subagent.updated");
    expect(first.botId).toBeTruthy();
    expect(first.botId).toBe(second.botId);
    const bot = store.bot(first.botId!);
    expect(bot?.name).toBe("Researcher");
    expect(bot?.id).toBe(first.botId);
    expect(bot?.reportsToBotId).toBe(parent.id);
    expect(bot?.hermesProvenance).toMatchObject({
      hermesAgentId: "hermes-researcher",
      kind: "persistent",
      parentBotId: parent.id,
    });
    expect(JSON.stringify(first.event)).not.toMatch(/token|HERMES_HOME|\/Users\/|sk-/i);
  });

  it("keeps a temporary MoA agent nested in the parent chat until promote", async () => {
    const { projectHermesAgent, completeHermesAgent, promoteHermesAgent } = await import("./hermes-agent-projection.ts");
    const store = new Store(selection);
    const parent = store.createBot({ name: "Chief" }, { seedMessages: false });
    const started = projectHermesAgent(store, {
      hermesAgentId: "moa-temp-1",
      kind: "temporary",
      name: "Draft review",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    expect(started.botId).toBeUndefined();
    expect(started.activityId).toBeTruthy();
    expect(store.bots.some((bot) => bot.name === "Draft review")).toBe(false);

    const again = projectHermesAgent(store, {
      hermesAgentId: "moa-temp-1",
      kind: "temporary",
      name: "Draft review",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    expect(again.activityId).toBe(started.activityId);

    store.appendMessage(started.transcriptThreadId, { role: "bot", kind: "text", text: "draft notes" });
    const completed = completeHermesAgent(store, { hermesAgentId: "moa-temp-1" });
    expect(completed.event.type).toBe("subagent.completed");
    expect(store.messagesFor(started.transcriptThreadId).some((message) => message.text === "draft notes")).toBe(true);

    const promoted = promoteHermesAgent(store, { hermesAgentId: "moa-temp-1" });
    expect(promoted.event.type).toBe("subagent.promoted");
    expect(promoted.botId).toBeTruthy();
    const bot = store.bot(promoted.botId!);
    expect(bot?.name).toBe("Draft review");
    expect(bot?.hermesProvenance).toMatchObject({
      hermesAgentId: "moa-temp-1",
      kind: "promoted",
      parentBotId: parent.id,
      sourceActivityId: started.activityId,
    });
    expect(store.messagesFor(bot!.threadId).some((message) => message.text === "draft notes")).toBe(true);
  });

  it("lists temporary activities for existing fleet hydrate without minting a second agent model", async () => {
    const { projectHermesAgent, completeHermesAgent, listProjectedHermesActivities } = await import(
      "./hermes-agent-projection.ts"
    );
    const store = new Store(selection);
    const parent = store.createBot({ name: "Chief" }, { seedMessages: false });
    const started = projectHermesAgent(store, {
      hermesAgentId: "moa-temp-live",
      kind: "temporary",
      name: "Draft review",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    store.appendMessage(started.transcriptThreadId, { role: "bot", kind: "text", text: "live notes" });
    completeHermesAgent(store, { hermesAgentId: "moa-temp-live" });
    const listed = listProjectedHermesActivities();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      activityId: started.activityId,
      parentThreadId: parent.threadId,
      title: "Draft review",
      status: "completed",
      transcriptThreadId: started.transcriptThreadId,
      promoteEligible: true,
    });
    expect(listed[0]?.updatedAt).toBeGreaterThan(0);
    expect(JSON.stringify(listed)).not.toMatch(/token|HERMES_HOME|\/Users\/|sk-|hermesAgentId|moa-temp-live/i);
  });

  it("emits a sanitized SSE frame for started, updated, and completed temporary agents", async () => {
    const { projectHermesAgent, completeHermesAgent, projectedHermesSubagentFrame } = await import(
      "./hermes-agent-projection.ts"
    );
    const store = new Store(selection);
    const parent = store.createBot({ name: "Chief" }, { seedMessages: false });
    const started = projectHermesAgent(store, {
      hermesAgentId: "moa-temp-sse",
      kind: "temporary",
      name: "Draft review",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    const startedFrame = projectedHermesSubagentFrame(started.activityId);
    expect(startedFrame).toMatchObject({
      kind: "hermes.subagent",
      activity: {
        activityId: started.activityId,
        parentThreadId: parent.threadId,
        title: "Draft review",
        status: "started",
        transcriptThreadId: started.transcriptThreadId,
        promoteEligible: false,
      },
    });
    expect(startedFrame?.activity.updatedAt).toBeGreaterThan(0);
    expect(JSON.stringify(startedFrame)).not.toMatch(/token|HERMES_HOME|\/Users\/|sk-|hermesAgentId|moa-temp-sse/i);

    const replayed = projectedHermesSubagentFrame(started.activityId);
    expect(replayed).toEqual(startedFrame);

    const updated = projectHermesAgent(store, {
      hermesAgentId: "moa-temp-sse",
      kind: "temporary",
      name: "Draft review",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    expect(projectedHermesSubagentFrame(updated.activityId)?.activity.status).toBe("updated");

    completeHermesAgent(store, { hermesAgentId: "moa-temp-sse" });
    const completedFrame = projectedHermesSubagentFrame(started.activityId);
    expect(completedFrame?.activity.status).toBe("completed");
    expect(completedFrame?.activity.promoteEligible).toBe(true);
    expect(JSON.stringify(completedFrame)).not.toMatch(/token|HERMES_HOME|\/Users\/|sk-|runtime|session/i);
  });

  it("does not mint a new identity when the projection store is unreadable", async () => {
    const { projectHermesAgent, markHermesProjectionStoreUnreadable } = await import("./hermes-agent-projection.ts");
    const store = new Store(selection);
    const parent = store.createBot({ name: "Chief" }, { seedMessages: false });
    markHermesProjectionStoreUnreadable();
    expect(() =>
      projectHermesAgent(store, {
        hermesAgentId: "hermes-researcher",
        kind: "persistent",
        name: "Researcher",
        parentBotId: parent.id,
        parentThreadId: parent.threadId,
      }),
    ).toThrow(/unavailable/i);
    expect(store.bots.filter((bot) => bot.name === "Researcher")).toHaveLength(0);
  });

  it("sanitizes secretish titles before persist and broadcast instead of throwing", async () => {
    const { projectHermesAgent, listProjectedHermesActivities, projectedHermesSubagentFrame } = await import(
      "./hermes-agent-projection.ts"
    );
    const store = new Store(selection);
    const parent = store.createBot({ name: "Chief" }, { seedMessages: false });
    const started = projectHermesAgent(store, {
      hermesAgentId: "moa-temp-title",
      kind: "temporary",
      name: "Review token sk-ant-secret-value /Users/vincent/.hermes",
      parentBotId: parent.id,
      parentThreadId: parent.threadId,
    });
    expect(started.event.title).toBe("Temporary agent");
    expect(JSON.stringify(started)).not.toMatch(/sk-ant-secret-value|\/Users\/vincent/i);

    expect(() => listProjectedHermesActivities()).not.toThrow();
    const listed = listProjectedHermesActivities();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Temporary agent");
    expect(JSON.stringify(listed)).not.toMatch(/sk-ant-secret-value|HERMES_HOME|\/Users\/vincent|token/i);

    expect(() => projectedHermesSubagentFrame(started.activityId)).not.toThrow();
    const frame = projectedHermesSubagentFrame(started.activityId);
    expect(frame?.activity.title).toBe("Temporary agent");
    expect(frame?.activity.status).toBe("started");
    expect(JSON.stringify(frame)).not.toMatch(/sk-ant-secret-value|\/Users\/vincent|token/i);
  });
});
