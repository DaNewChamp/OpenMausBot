import { describe, expect, it } from "vitest";

import {
  HermesCommBudget,
  HermesCommReplay,
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
});
