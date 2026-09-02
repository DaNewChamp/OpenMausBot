import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../server/contracts.ts";
import type { HermesBotEngine } from "../../server/engines/hermes.ts";
import {
  createHermesBridgeRuntimeFromEngine,
} from "./hermes-runtime.ts";
import { resetHermesJobQueueForTests, runHermesJobSerialized } from "./hermes-queue.ts";

function baseEvent(turnId: string, type: RuntimeEvent["type"], extra: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    eventId: `evt-${turnId}-${type}`,
    provider: "hermesBot",
    threadId: "thread-1",
    turnId,
    createdAt: "2026-09-01T00:00:00.000Z",
    type,
    ...extra,
  } as RuntimeEvent;
}

function createMockEngine(state: {
  closeCount?: { value: number };
  eventsByTurn?: Record<string, RuntimeEvent[]>;
  deferredTerminalByTurn?: Record<string, { delayMs: number; events: RuntimeEvent[] }>;
  sendDelayMs?: number;
  sendError?: Error;
  interrupt?: ReturnType<typeof vi.fn>;
}): HermesBotEngine {
  const closeCount = state.closeCount ?? { value: 0 };
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const interrupt = state.interrupt ?? vi.fn(async () => {});
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
      const deferred = state.deferredTerminalByTurn?.[payload.turnId];
      const immediate = state.eventsByTurn?.[payload.turnId] ?? [];
      for (const event of immediate) listeners.forEach((listener) => listener(event));
      if (state.sendError) throw state.sendError;
      if (deferred) {
        setTimeout(() => {
          for (const event of deferred.events) listeners.forEach((listener) => listener(event));
        }, deferred.delayMs);
      }
      if (state.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, state.sendDelayMs));
      return { turnId: payload.turnId };
    },
    interrupt,
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
        "turn-a": [baseEvent("turn-a", "content.delta", { streamKind: "assistant_text", delta: "job-a" }),
          baseEvent("turn-a", "turn.completed", { ok: true, stopReason: null })],
        "turn-b": [baseEvent("turn-b", "content.delta", { streamKind: "assistant_text", delta: "job-b" }),
          baseEvent("turn-b", "turn.completed", { ok: true, stopReason: null })],
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
    expect(first.events).toEqual([
      expect.objectContaining({ delta: "job-a" }),
      expect.objectContaining({ type: "turn.completed", turnId: "turn-a" }),
    ]);
    expect(second.events).toEqual([
      expect.objectContaining({ delta: "job-b" }),
      expect.objectContaining({ type: "turn.completed", turnId: "turn-b" }),
    ]);
  });
});

describe("Hermes bridge runtime terminal delivery", () => {
  it("waits for async terminal events after prompt.submit returns", async () => {
    const engine = createMockEngine({
      eventsByTurn: {
        "turn-live": [
          baseEvent("turn-live", "turn.started"),
          baseEvent("turn-live", "session.started", { sessionId: null }),
        ],
      },
      deferredTerminalByTurn: {
        "turn-live": {
          delayMs: 20,
          events: [
            baseEvent("turn-live", "content.delta", { streamKind: "assistant_text", delta: "hello" }),
            baseEvent("turn-live", "turn.completed", { ok: true, stopReason: null }),
          ],
        },
      },
    });
    const runtime = createHermesBridgeRuntimeFromEngine(engine);
    const result = await runtime.send({
      profile: "default",
      text: "hello",
      threadId: "thread-1",
      turnId: "turn-live",
    });
    expect(result).toMatchObject({ ok: true, turnId: "turn-live" });
    expect(result.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "turn.completed",
    ]);
  });

  it("returns failure when the matching runtime.error terminal arrives", async () => {
    const engine = createMockEngine({
      eventsByTurn: {
        "turn-fail": [baseEvent("turn-fail", "turn.started")],
      },
      deferredTerminalByTurn: {
        "turn-fail": {
          delayMs: 10,
          events: [baseEvent("turn-fail", "runtime.error", { message: "upstream failed", setup: false })],
        },
      },
    });
    const runtime = createHermesBridgeRuntimeFromEngine(engine);
    const result = await runtime.send({
      profile: "default",
      text: "boom",
      threadId: "thread-1",
      turnId: "turn-fail",
    });
    expect(result).toMatchObject({ ok: false, reason: "upstream_error", turnId: "turn-fail" });
    expect(result.events.at(-1)).toMatchObject({ type: "runtime.error" });
  });

  it("interrupts and returns scrubbed events when aborted mid-turn", async () => {
    const interrupt = vi.fn(async () => {});
    const engine = createMockEngine({
      eventsByTurn: {
        "turn-abort": [baseEvent("turn-abort", "turn.started")],
      },
      deferredTerminalByTurn: {
        "turn-abort": {
          delayMs: 100,
          events: [baseEvent("turn-abort", "turn.completed", { ok: true, stopReason: null })],
        },
      },
      interrupt,
    });
    const runtime = createHermesBridgeRuntimeFromEngine(engine);
    const controller = new AbortController();
    const sendPromise = runtime.send({
      profile: "default",
      text: "stop",
      threadId: "thread-1",
      turnId: "turn-abort",
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await sendPromise;
    expect(interrupt).toHaveBeenCalledWith("default", "turn-abort");
    expect(result).toMatchObject({ ok: false, reason: "upstream_error", turnId: "turn-abort" });
    expect(result.events).toEqual([expect.objectContaining({ type: "turn.started" })]);
  });

  it("does not treat another turn's terminal event as completion", async () => {
    const engine = createMockEngine({
      eventsByTurn: {
        "turn-wait": [baseEvent("turn-wait", "turn.started")],
      },
      deferredTerminalByTurn: {
        "turn-wait": {
          delayMs: 20,
          events: [
            baseEvent("turn-other", "turn.completed", { ok: true, stopReason: null }),
            baseEvent("turn-wait", "turn.completed", { ok: true, stopReason: null }),
          ],
        },
      },
    });
    const runtime = createHermesBridgeRuntimeFromEngine(engine);
    const result = await runtime.send({
      profile: "default",
      text: "wait",
      threadId: "thread-1",
      turnId: "turn-wait",
    });
    expect(result.ok).toBe(true);
    expect(result.events.at(-1)).toMatchObject({ type: "turn.completed", turnId: "turn-wait" });
  });

  it("keeps synchronous terminal delivery for engines that finish inside send", async () => {
    const engine = createMockEngine({
      eventsByTurn: {
        "turn-sync": [
          baseEvent("turn-sync", "turn.started"),
          baseEvent("turn-sync", "content.delta", { streamKind: "assistant_text", delta: "done" }),
          baseEvent("turn-sync", "turn.completed", { ok: true, stopReason: null }),
        ],
      },
    });
    const runtime = createHermesBridgeRuntimeFromEngine(engine);
    const result = await runtime.send({
      profile: "default",
      text: "sync",
      threadId: "thread-1",
      turnId: "turn-sync",
    });
    expect(result).toMatchObject({ ok: true, turnId: "turn-sync" });
    expect(result.events.map((event) => event.type)).toEqual(["turn.started", "content.delta", "turn.completed"]);
  });
});
