import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../server/contracts.ts";
import type { HermesBotEngine } from "../../server/engines/hermes.ts";
import {
  createHermesBridgeRuntimeFromEngine,
} from "./hermes-runtime.ts";
import { resetHermesJobQueueForTests, runHermesJobSerialized } from "./hermes-queue.ts";

function createMockEngine(state: {
  closeCount?: { value: number };
  eventsByTurn?: Record<string, RuntimeEvent[]>;
  sendDelayMs?: number;
}): HermesBotEngine {
  const closeCount = state.closeCount ?? { value: 0 };
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    discover: async () => ({
      state: "available",
      capabilities: {
        roster: true,
        canonicalChat: true,
        send: true,
        finalResponse: true,
        events: true,
        stop: true,
        routinesRead: false,
        messageAgent: false,
        groups: false,
        crossMachine: false,
        queueing: false,
        steer: false,
        attachments: false,
      },
      profiles: [],
    }),
    resolveCanonical: async () => ({ profile: "default", title: "Bot Chat", rootSessionId: "r", resolvedSessionId: "s", messageCount: 0 }),
    send: async (payload: { turnId: string }) => {
      const events = state.eventsByTurn?.[payload.turnId] ?? [];
      for (const event of events) listeners.forEach((listener: (event: RuntimeEvent) => void) => listener(event));
      if (state.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, state.sendDelayMs));
      return { turnId: payload.turnId };
    },
    interrupt: async () => {},
    onEvent: (listener: (event: RuntimeEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closeCount.value += 1;
    },
  } as unknown as HermesBotEngine;
}

describe("Hermes bridge runtime lifecycle", () => {
  it("does not close the shared engine when a job runtime is disposed", async () => {
    const closeCount = { value: 0 };
    const engine = createMockEngine({ closeCount });
    const runtime = createHermesBridgeRuntimeFromEngine(engine, { closeOnDispose: false });
    await runtime.discover();
    await runtime.close();
    expect(closeCount.value).toBe(0);
  });

  it("isolates send events per serialized job via independent listeners", async () => {
    resetHermesJobQueueForTests();
    const engine = createMockEngine({
      eventsByTurn: {
        "turn-a": [{
          eventId: "evt-a",
          provider: "hermesBot",
          threadId: "thread-1",
          turnId: "turn-a",
          createdAt: "2026-09-01T00:00:00.000Z",
          type: "content.delta",
          streamKind: "assistant_text",
          delta: "job-a",
        }],
        "turn-b": [{
          eventId: "evt-b",
          provider: "hermesBot",
          threadId: "thread-1",
          turnId: "turn-b",
          createdAt: "2026-09-01T00:00:00.000Z",
          type: "content.delta",
          streamKind: "assistant_text",
          delta: "job-b",
        }],
      },
      sendDelayMs: 20,
    });
    const runtime = createHermesBridgeRuntimeFromEngine(engine, { closeOnDispose: false });
    const [first, second] = await Promise.all([
      runHermesJobSerialized(() => runtime.send({
        profile: "default",
        text: "a",
        threadId: "thread-1",
        turnId: "turn-a",
      })),
      runHermesJobSerialized(() => runtime.send({
        profile: "default",
        text: "b",
        threadId: "thread-1",
        turnId: "turn-b",
      })),
    ]);
    expect(first.events).toEqual([expect.objectContaining({ delta: "job-a" })]);
    expect(second.events).toEqual([expect.objectContaining({ delta: "job-b" })]);
  });
});
