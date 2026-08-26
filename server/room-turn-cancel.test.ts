import { describe, expect, it } from "vitest";

import { RoomTurnCancellation } from "./room-turn-cancel.ts";

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
});
