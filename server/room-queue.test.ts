import { describe, expect, it, vi } from "vitest";

import { runWhenRoomIdle, type RoomQueueState } from "./room-queue.ts";

function fakeRoomState(busyBotId: string | null): RoomQueueState & {
  setBusy(value: string | null): void;
  deleteRoom(): void;
} {
  let group: { busyBotId: string | null } | undefined = { busyBotId };
  const listeners = new Set<(change: { type: string; groupId?: string }) => void>();
  return {
    group: () => group,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setBusy: (value) => {
      if (!group) return;
      group.busyBotId = value;
      for (const listener of listeners) listener({ type: "group", groupId: "room-1" });
    },
    deleteRoom: () => {
      group = undefined;
      for (const listener of listeners) listener({ type: "group.deleted", groupId: "room-1" });
    },
  };
}

describe("serialized room queue", () => {
  it("retains a turn until a stale busy owner releases, then dispatches once", async () => {
    const state = fakeRoomState("bot-1");
    const run = vi.fn();
    const pending = runWhenRoomIdle(state, "room-1", run, 50);

    expect(run).not.toHaveBeenCalled();
    state.setBusy(null);

    await expect(pending).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels a retained turn when its room is deleted", async () => {
    const state = fakeRoomState("bot-1");
    const run = vi.fn();
    const pending = runWhenRoomIdle(state, "room-1", run, 50);

    state.deleteRoom();

    await expect(pending).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
