import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import {
  ASK_BOT_TIMEOUT_FAILURE,
  ASK_BOT_WAIT_MS,
  askBotFailedChip,
  askBotFinishedChip,
  askBotStillWorkingChip,
  askBotStillWorkingNote,
  waitForAskBotReply,
  type AskBotLateResult,
  type AskBotWaitBus,
} from "./ask-bot-wait.ts";

function fakeBus(): AskBotWaitBus & { emit: (event: RuntimeEvent) => void } {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function event(over: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">): RuntimeEvent {
  return {
    eventId: "ev",
    provider: "fake",
    threadId: "target-thread",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as RuntimeEvent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForAskBotReply", () => {
  it("returns the peer's reply when the turn finishes before the ceiling", async () => {
    const bus = fakeBus();
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      start: () => {
        bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "hello from helper" }));
        bus.emit(event({ type: "turn.completed", ok: true }));
      },
    });
    await expect(pending).resolves.toEqual({ status: "completed", text: "hello from helper" });
  });

  it("joins multiple assistant_text chunks", async () => {
    const bus = fakeBus();
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      start: () => {
        bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "part one" }));
        bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "part two" }));
        bus.emit(event({ type: "turn.completed", ok: true }));
      },
    });
    await expect(pending).resolves.toEqual({ status: "completed", text: "part one\npart two" });
  });

  it("ignores events from other threads", async () => {
    const bus = fakeBus();
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      start: () => {
        bus.emit(
          event({
            type: "item.completed",
            itemType: "assistant_text",
            text: "wrong thread",
            threadId: "other-thread",
          }),
        );
        bus.emit(event({ type: "turn.completed", ok: true, threadId: "other-thread" }));
        bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "right thread" }));
        bus.emit(event({ type: "turn.completed", ok: true }));
      },
    });
    await expect(pending).resolves.toEqual({ status: "completed", text: "right thread" });
  });

  it("does not treat the four-minute ceiling as a timeout failure", async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const onPending = vi.fn();
    const late: AskBotLateResult[] = [];
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      timeoutMs: ASK_BOT_WAIT_MS,
      start: () => {},
      onPending,
      onLateComplete: (result) => late.push(result),
    });

    await vi.advanceTimersByTimeAsync(ASK_BOT_WAIT_MS - 1);
    expect(onPending).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe("pending");
    expect(result).toMatchObject({ status: "pending", partial: "" });
    if (result.status !== "pending") throw new Error("expected pending");
    expect(result.text).toBe(askBotStillWorkingNote("the bot"));
    expect(result.text).not.toContain(ASK_BOT_TIMEOUT_FAILURE);
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(late).toEqual([]);
  });

  it("keeps watching and delivers a late completion after the ceiling", async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const late: AskBotLateResult[] = [];
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      timeoutMs: ASK_BOT_WAIT_MS,
      start: () => {},
      onLateComplete: (result) => late.push(result),
    });

    await vi.advanceTimersByTimeAsync(ASK_BOT_WAIT_MS);
    const result = await pending;
    expect(result.status).toBe("pending");
    expect(JSON.stringify(result)).not.toContain(ASK_BOT_TIMEOUT_FAILURE);

    bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "late answer" }));
    bus.emit(event({ type: "turn.completed", ok: true }));
    expect(late).toEqual([{ ok: true, text: "late answer" }]);
  });

  it("lets the harness cancel the late listener when a terminal has no turn.completed event", async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const late: AskBotLateResult[] = [];
    let cancelLateWatch: (() => void) | undefined;
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      timeoutMs: ASK_BOT_WAIT_MS,
      start: () => {},
      onPending: (cancel) => {
        cancelLateWatch = cancel;
      },
      onLateComplete: (result) => late.push(result),
    });

    await vi.advanceTimersByTimeAsync(ASK_BOT_WAIT_MS);
    await pending;
    cancelLateWatch?.();
    bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "wrong next turn" }));
    bus.emit(event({ type: "turn.completed", ok: true }));
    expect(late).toEqual([]);
  });

  it("includes pre-ceiling partial text in the late result, not as a fake reply", async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const late: AskBotLateResult[] = [];
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      timeoutMs: ASK_BOT_WAIT_MS,
      start: () => {
        bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "still drafting" }));
      },
      onLateComplete: (result) => late.push(result),
    });

    await vi.advanceTimersByTimeAsync(ASK_BOT_WAIT_MS);
    const result = await pending;
    expect(result).toEqual({
      status: "pending",
      text: askBotStillWorkingNote("the bot"),
      partial: "still drafting",
    });
    expect(result.status === "pending" && result.text).not.toBe("still drafting");

    bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "and done" }));
    bus.emit(event({ type: "turn.completed", ok: true }));
    expect(late).toEqual([{ ok: true, text: "still drafting\nand done" }]);
  });

  it("delivers a late failure after the ceiling without inventing a timeout reply", async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const late: AskBotLateResult[] = [];
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      timeoutMs: ASK_BOT_WAIT_MS,
      start: () => {},
      onLateComplete: (result) => late.push(result),
    });

    await vi.advanceTimersByTimeAsync(ASK_BOT_WAIT_MS);
    await pending;
    bus.emit(event({ type: "turn.completed", ok: false }));
    expect(late).toEqual([{ ok: false, text: "" }]);
  });

  it("does not fire onLateComplete when the turn finishes in time", async () => {
    const bus = fakeBus();
    const late: AskBotLateResult[] = [];
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      start: () => {
        bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "quick" }));
        bus.emit(event({ type: "turn.completed", ok: true }));
      },
      onLateComplete: (result) => late.push(result),
    });
    await pending;
    bus.emit(event({ type: "item.completed", itemType: "assistant_text", text: "too late" }));
    bus.emit(event({ type: "turn.completed", ok: true }));
    expect(late).toEqual([]);
  });

  it("reports a start failure instead of waiting out the ceiling", async () => {
    await expect(
      waitForAskBotReply({
        bus: fakeBus(),
        threadId: "target-thread",
        start: () => {
          throw new Error("provider unavailable");
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      text: "(couldn't start that bot: provider unavailable)",
    });
  });

  it("lets the harness fail an active wait before the pending ceiling", async () => {
    let control: { fail(reason: string): void } | undefined;
    const pending = waitForAskBotReply({
      bus: fakeBus(),
      threadId: "target-thread",
      start: () => {},
      onControl: (value) => {
        control = value;
      },
    });

    control?.fail("provider settings changed");
    await expect(pending).resolves.toEqual({
      status: "failed",
      text: "(couldn't start that bot: provider settings changed)",
    });
  });

  it("turns a late start failure into onLateComplete after the ceiling", async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const late: AskBotLateResult[] = [];
    let fail: ((reason: string) => void) | undefined;
    const pending = waitForAskBotReply({
      bus,
      threadId: "target-thread",
      timeoutMs: ASK_BOT_WAIT_MS,
      start: (ctl) => {
        fail = ctl.fail;
      },
      onLateComplete: (result) => late.push(result),
    });

    await vi.advanceTimersByTimeAsync(ASK_BOT_WAIT_MS);
    await pending;
    fail?.("dispatch died");
    expect(late).toEqual([{ ok: false, text: "" }]);
  });
});

describe("ask_bot still-working copy", () => {
  it("names the teammate and never looks like a timeout error", () => {
    expect(askBotStillWorkingNote("Helper")).toContain("@Helper is still working");
    expect(askBotStillWorkingNote("Helper")).not.toContain(ASK_BOT_TIMEOUT_FAILURE);
    expect(askBotStillWorkingChip("Helper")).toBe("@Helper is still working");
    expect(askBotFinishedChip("Helper")).toBe("@Helper finished");
    expect(askBotFailedChip("Helper")).toBe("@Helper did not finish");
  });
});
