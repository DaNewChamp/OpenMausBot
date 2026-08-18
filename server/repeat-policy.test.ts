import { describe, expect, it } from "vitest";

import { REPEAT_THRESHOLDS, repeatAction } from "./repeat-policy.ts";

describe("repeatAction", () => {
  it("nudges into the turn on an engine that can take a message mid-turn", () => {
    const a = repeatAction({ threshold: 5, tool: "Bash", args: "git status", canSteer: true });
    expect(a.stop).toBeUndefined();
    expect(a.chip).toMatch(/repeated 5×.*Bash: git status.*nudged/);
    expect(a.steer).toMatch(/run the same call 5 times.*Bash: git status/);
    expect(a.steer).toMatch(/stopped at 20/);
  });

  it("only chips on an engine that cannot be steered", () => {
    const a = repeatAction({ threshold: 10, tool: "Bash", args: "git status", canSteer: false });
    expect(a.steer).toBeUndefined();
    expect(a.stop).toBeUndefined();
    expect(a.chip).toMatch(/repeated 10×.*it may be stuck/);
  });

  it("stops at the ceiling regardless of engine", () => {
    for (const canSteer of [true, false]) {
      const a = repeatAction({ threshold: 20, tool: "Bash", args: "git status", canSteer });
      expect(a.stop).toBe(true);
      expect(a.steer).toBeUndefined();
      expect(a.chip).toMatch(/^error: stopped — the same call repeated 20×/);
    }
  });

  it("clips long arguments in the human-facing text", () => {
    const a = repeatAction({ threshold: 5, tool: "Bash", args: "x".repeat(200), canSteer: false });
    expect(a.chip).toContain("x".repeat(80) + "…");
    expect(a.chip.length).toBeLessThan(200);
  });

  it("thresholds are the detector's: 5, 10, 20", () => {
    expect([...REPEAT_THRESHOLDS]).toEqual([5, 10, 20]);
  });
});
