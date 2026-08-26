import { describe, expect, it, vi } from "vitest";

import { dispatchRoomTurn, RoomTurnCancellation } from "./room-turn-cancel.ts";

describe("room turn cancellation", () => {
  it("cancels the active generation without cancelling a later queued run", () => {
    const cancellation = new RoomTurnCancellation();
    const active = cancellation.begin("room-1");

    expect(cancellation.interrupt("room-1")).toBe(true);
    expect(cancellation.isCancelled("room-1", active)).toBe(true);

    cancellation.finish("room-1", active);
    const later = cancellation.begin("room-1");
    expect(cancellation.isCancelled("room-1", later)).toBe(false);
  });

  it("does not poison a future run when an idle room is interrupted", () => {
    const cancellation = new RoomTurnCancellation();

    expect(cancellation.interrupt("room-2")).toBe(false);
    const later = cancellation.begin("room-2");
    expect(cancellation.isCancelled("room-2", later)).toBe(false);
  });

  it("does not let an old run finish a newer run's slot", () => {
    const cancellation = new RoomTurnCancellation();
    const first = cancellation.begin("room-3");
    const second = cancellation.begin("room-3");

    cancellation.finish("room-3", first);
    expect(cancellation.isCancelled("room-3", second)).toBe(false);
    cancellation.interrupt("room-3");
    expect(cancellation.isCancelled("room-3", second)).toBe(true);
  });

  it("notifies a dispatch that is registering after Stop", () => {
    const cancellation = new RoomTurnCancellation();
    const run = cancellation.begin("thread-4");
    const onCancel = vi.fn();
    cancellation.onCancel("thread-4", run, onCancel);

    expect(cancellation.interrupt("thread-4")).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(cancellation.isCancelled("thread-4", run)).toBe(true);
    // The late registration gets the already-fired signal too.
    const late = vi.fn();
    cancellation.onCancel("thread-4", run, late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("retires deleted threads without poisoning a new immutable thread", () => {
    const cancellation = new RoomTurnCancellation();
    const deleted = cancellation.begin("thread-old");
    expect(cancellation.retire("thread-old")).toBe(true);
    expect(cancellation.current("thread-old")).toBeNull();
    expect(cancellation.isCancelled("thread-old", deleted)).toBe(true);

    const recreated = cancellation.begin("thread-new");
    expect(recreated.generation).toBe(1);
    expect(cancellation.isCancelled("thread-new", recreated)).toBe(false);
    expect(cancellation.isCancelled("thread-new", deleted)).toBe(true);

    cancellation.finish("thread-new", recreated);
    const reusedThread = cancellation.begin("thread-old");
    expect(reusedThread.generation).toBe(1);
    expect(cancellation.isCancelled("thread-old", reusedThread)).toBe(false);
    expect(cancellation.isCancelled("thread-old", deleted)).toBe(true);
  });

  it("re-interrupts after a delayed adapter registration and never advances", async () => {
    const cancellation = new RoomTurnCancellation();
    const run = cancellation.begin("thread-race");
    let releaseDispatch!: () => void;
    let registered = false;
    let stopped = false;
    const dispatch = () =>
      new Promise<{ started: boolean }>((resolve) => {
        releaseDispatch = () => {
          registered = true;
          resolve({ started: true });
        };
      });
    const interrupt = vi.fn(async () => {
      if (registered) stopped = true;
    });

    const pending = dispatchRoomTurn(cancellation, run, dispatch, interrupt);
    cancellation.interrupt("thread-race");
    releaseDispatch();
    const result = await pending;

    expect(result).toMatchObject({ cancelled: true, started: true });
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(stopped).toBe(true);
    // A room chain only advances when its member dispatch is not cancelled.
    const nextResponder = vi.fn();
    if (!result.cancelled) nextResponder();
    expect(nextResponder).not.toHaveBeenCalled();
  });

  it("reports a stopped dispatch rejection as not started so room ownership can be released", async () => {
    const cancellation = new RoomTurnCancellation();
    const run = cancellation.begin("thread-rejected");
    const interrupt = vi.fn();
    const dispatch = vi.fn(async () => {
      // Model an adapter rejecting after Stop won the race but before it
      // registered a provider turn. No turn.completed can arrive for this
      // invocation, so the caller must release its room owner immediately.
      cancellation.interrupt("thread-rejected");
      throw new Error("stopped before provider registration");
    });

    const result = await dispatchRoomTurn(cancellation, run, dispatch, interrupt);

    expect(result).toEqual({ cancelled: true, started: false });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledTimes(2);

    const room = {
      busyBotId: "bot-1" as string | null,
      activity: "working" as "working" | "idle",
      speakerBotId: "bot-1" as string | null,
      watchdogWatching: true,
      queuedMessages: ["later"],
    };
    if (result.cancelled && !result.started) {
      room.busyBotId = null;
      room.activity = "idle";
      room.speakerBotId = null;
      room.watchdogWatching = false;
      room.queuedMessages.shift();
    }
    expect(room).toEqual({
      busyBotId: null,
      activity: "idle",
      speakerBotId: null,
      watchdogWatching: false,
      queuedMessages: [],
    });
  });

  it("does not turn a normally finished dispatch into a cancellation", async () => {
    const cancellation = new RoomTurnCancellation();
    const run = cancellation.begin("thread-finished");
    const interrupt = vi.fn();
    const result = await dispatchRoomTurn(
      cancellation,
      run,
      async () => {
        cancellation.finish("thread-finished", run);
        return { started: true };
      },
      interrupt,
    );

    expect(result).toEqual({ value: { started: true }, cancelled: false, started: true });
    expect(interrupt).not.toHaveBeenCalled();
  });
});
