// Bounding what a harness-owned MCP server hands back to an agent.
//
// The thing being pinned down is the trade: a caller must never lose the
// beginning of an output, must always be TOLD when the rest was dropped, and
// must be able to go get it when the bot has somewhere to read it from.
import { describe, expect, it } from "vitest";

import { SPILL_HEAD_BYTES, SPILL_THRESHOLD_BYTES, boundToolText } from "./tool-output.ts";

describe("boundToolText", () => {
  it("returns short output untouched", () => {
    expect(boundToolText("all good")).toBe("all good");
  });

  it("keeps a head slice and says how much was dropped when there is no workspace", () => {
    const big = "x".repeat(SPILL_THRESHOLD_BYTES + 5_000);
    const bounded = boundToolText(big);
    expect(bounded.length).toBeLessThan(SPILL_HEAD_BYTES + 500);
    expect(bounded.startsWith("x".repeat(100))).toBe(true);
    expect(bounded).toContain("truncated");
    expect(bounded).toContain(String(big.length));
    expect(bounded).not.toContain(".txt");
  });
});
