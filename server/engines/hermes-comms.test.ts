import { describe, expect, it } from "vitest";

import {
  HermesCommBudget,
  HermesCommReplay,
  REPLAY_TTL_MS,
  deliveryKey,
  normalizeMessageAgentBody,
  resolveLocalTarget,
} from "./hermes-comms.ts";

describe("hermes-comms", () => {
  it("refuses peer/agent and oversize bodies", () => {
    expect(resolveLocalTarget("spark/researcher", new Map([["researcher", "bot-1"]]))).toBeNull();
    expect(normalizeMessageAgentBody("x".repeat(16_001))).toMatchObject({ ok: false });
  });

  it("hashes delivery keys without Hermes session ids", () => {
    const key = deliveryKey({ fromBotId: "a", toBotId: "b", turnId: "t", text: "hi" });
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toMatch(/session|HERMES|Bot Chat/i);
  });

  it("drops the fifth message_agent on the same turn", () => {
    const budget = new HermesCommBudget(4);
    expect([1, 2, 3, 4].every(() => budget.tryConsume("t"))).toBe(true);
    expect(budget.tryConsume("t")).toBe(false);
  });

  it("does not re-project an identical deliveryKey", () => {
    const replay = new HermesCommReplay();
    const key = deliveryKey({ fromBotId: "a", toBotId: "b", turnId: "t", text: "hi" });
    expect(replay.remember(key)).toBe(true);
    expect(replay.remember(key)).toBe(false);
  });

  it("expires delivery keys after 24h using an injectable clock", () => {
    let now = 1_700_000_000_000;
    const replay = new HermesCommReplay({ clock: { now: () => now } });
    const key = deliveryKey({ fromBotId: "a", toBotId: "b", turnId: "t", text: "hi" });
    expect(replay.remember(key)).toBe(true);
    now += REPLAY_TTL_MS - 1;
    expect(replay.remember(key)).toBe(false);
    now += 1;
    expect(replay.remember(key)).toBe(true);
  });

  it("bounds replay cleanup work per remember call", () => {
    let now = 0;
    const replay = new HermesCommReplay({ clock: { now: () => now }, cleanupLimit: 2 });
    for (let index = 0; index < 5; index += 1) {
      replay.remember(`key-${index}`);
      now += REPLAY_TTL_MS + 1;
    }
    expect(replay.sizeForTests()).toBeLessThanOrEqual(3);
  });
});
