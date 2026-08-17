import { describe, expect, it } from "vitest";

import { TurnLiveness } from "./liveness.ts";

const MIN = 60_000;
const opts = { quietAfterMs: 2 * MIN, stopAfterMs: 30 * MIN };

describe("TurnLiveness", () => {
  it("flags a busy thread once it has been quiet past the threshold, and only once", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { source: "user", at: 0 });
    expect(l.tick(1 * MIN)).toEqual([]);
    expect(l.tick(2 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 0 }]);
    // still quiet: no repeat flag
    expect(l.tick(3 * MIN)).toEqual([]);
  });

  it("clears the flag when events resume, and can flag again later", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { source: "user", at: 0 });
    l.tick(2 * MIN);
    l.touch("t1", 2.5 * MIN);
    expect(l.tick(2.6 * MIN)).toEqual([{ threadId: "t1", action: "clear" }]);
    expect(l.tick(4.4 * MIN)).toEqual([]);
    expect(l.tick(4.5 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 2.5 * MIN }]);
  });

  it("stops an automation-started turn after the long ceiling; never an interactive one", () => {
    const l = new TurnLiveness(opts);
    l.start("auto", { source: "automation", at: 0 });
    l.start("human", { source: "user", at: 0 });
    expect(l.tick(2 * MIN).map((a) => [a.threadId, a.action]).sort()).toEqual([
      ["auto", "flag"],
      ["human", "flag"],
    ]);
    expect(l.tick(29 * MIN)).toEqual([]);
    expect(l.tick(30 * MIN)).toEqual([{ threadId: "auto", action: "stop", quietSince: 0 }]);
    // stop is one-shot too; the harness settles the turn from here
    expect(l.tick(31 * MIN)).toEqual([]);
    expect(l.tick(120 * MIN)).toEqual([]);
  });

  it("forgets a thread on settle — no flags after the turn ended", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { source: "user", at: 0 });
    l.settle("t1");
    expect(l.tick(10 * MIN)).toEqual([]);
    expect(l.quietSince("t1")).toBeNull();
  });

  it("a settle on a flagged thread reports a clear so the UI drops the note", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { source: "user", at: 0 });
    l.tick(2 * MIN);
    expect(l.settle("t1")).toBe(true); // was flagged
    expect(l.settle("t1")).toBe(false); // already gone
  });

  it("restarting a thread's turn resets its clock", () => {
    const l = new TurnLiveness(opts);
    l.start("t1", { source: "user", at: 0 });
    l.tick(2 * MIN); // flagged
    l.start("t1", { source: "user", at: 3 * MIN });
    expect(l.quietSince("t1")).toBeNull();
    expect(l.tick(4 * MIN)).toEqual([]);
    expect(l.tick(5 * MIN)).toEqual([{ threadId: "t1", action: "flag", quietSince: 3 * MIN }]);
  });
});
