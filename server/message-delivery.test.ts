import { describe, expect, it } from "vitest";

import {
  decideDelivery,
  deliveryReceipt,
  parseDeliveryMode,
  parseDeliveryModeFromBody,
} from "./message-delivery.ts";

describe("message delivery contract", () => {
  it("defaults an omitted mode to auto and rejects unknown values", () => {
    expect(parseDeliveryMode(undefined)).toBe("auto");
    expect(parseDeliveryMode("steer")).toBe("steer");
    expect(parseDeliveryMode("queue")).toBe("queue");
    expect(() => parseDeliveryMode("later")).toThrow();
  });

  it("accepts the canonical companion field and preserves omitted auto mode", () => {
    expect(parseDeliveryModeFromBody({ delivery: "steer" })).toBe("steer");
    expect(parseDeliveryModeFromBody({ delivery: "queue" })).toBe("queue");
    expect(parseDeliveryModeFromBody({})).toBe("auto");
    expect(parseDeliveryModeFromBody({ deliveryMode: "queue" })).toBe("auto");
    expect(parseDeliveryModeFromBody({ mode: "steer" })).toBe("auto");
  });

  it("starts an idle conversation regardless of the requested mode", () => {
    for (const mode of ["auto", "steer", "queue"] as const) {
      expect(decideDelivery({ mode, busy: false, canSteer: false })).toBe("start");
    }
  });

  it("keeps explicit modes from silently changing meaning", () => {
    expect(decideDelivery({ mode: "steer", busy: true, canSteer: true })).toBe("steer");
    expect(decideDelivery({ mode: "steer", busy: true, canSteer: false })).toBe("unsupported");
    expect(decideDelivery({ mode: "queue", busy: true, canSteer: true })).toBe("queue");
    expect(decideDelivery({ mode: "auto", busy: true, canSteer: true })).toBe("steer");
    expect(decideDelivery({ mode: "auto", busy: true, canSteer: false })).toBe("queue");
  });

  it("only includes queue identifiers for queued work", () => {
    expect(deliveryReceipt("started", { queueId: "ignored", threadId: "ignored" })).toEqual({
      ok: true,
      disposition: "started",
    });
    expect(deliveryReceipt("steered", { queueId: "ignored" })).toEqual({
      ok: true,
      disposition: "steered",
    });
    expect(deliveryReceipt("queued", { queueId: "q-1", threadId: "t-1" })).toEqual({
      ok: true,
      disposition: "queued",
      queueId: "q-1",
      threadId: "t-1",
    });
  });
});
