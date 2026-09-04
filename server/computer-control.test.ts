// The who-is-driving record. What these tests pin is the authority split:
// the person's three moves (take, release, dismiss) all work, the bot's one
// move (requestHelp) never grants anything, and a release settles the help
// request in the same change the person made.
import { describe, expect, it } from "vitest";

import { ComputerControl, computerControlResourceKey, type ControlSnapshot } from "./computer-control.ts";

function tracked() {
  const changes: Array<{ botId: string; snapshot: ControlSnapshot }> = [];
  const control = new ComputerControl((botId, snapshot) => changes.push({ botId, snapshot }));
  return { control, changes };
}

describe("computer control", () => {
  it("starts disengaged for an unknown bot", () => {
    const { control } = tracked();
    expect(control.snapshot("b1")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("take → held; release → disengaged, each broadcast once", () => {
    const { control, changes } = tracked();
    const held = control.take("b1");
    expect(held.held).toBe(true);
    expect(held.heldSinceMs).not.toBeNull();
    expect(control.release("b1").held).toBe(false);
    expect(changes.map((c) => c.snapshot.held)).toEqual([true, false]);
  });

  it("a second take does not reset how long the hold has lasted", () => {
    let clock = 1000;
    const control = new ComputerControl(() => {}, () => clock);
    control.take("b1");
    clock = 5000;
    expect(control.take("b1").heldSinceMs).toBe(1000);
  });

  it("requestHelp surfaces the plea but never grants control", () => {
    const { control } = tracked();
    const snapshot = control.requestHelp("b1", "  please log in for me  ");
    expect(snapshot.held).toBe(false);
    expect(snapshot.helpReason).toBe("please log in for me");
  });

  it("an empty reason still reads as a plea", () => {
    const { control } = tracked();
    expect(control.requestHelp("b1", undefined).helpReason).toBe("the bot asked you to take over");
  });

  it("a shouted second reason cannot clobber the one the person is reading", () => {
    const { control } = tracked();
    control.requestHelp("b1", "first");
    expect(control.requestHelp("b1", "second").helpReason).toBe("first");
  });

  it("expires only the help request that owns the timeout", () => {
    const { control, changes } = tracked();
    const first = control.requestHelpLease("b1", "first");
    expect(control.expireHelp("b1", "some-older-request").helpReason).toBe("first");
    expect(changes).toHaveLength(1);
    expect(control.expireHelp("b1", first.requestId).helpReason).toBeNull();
    expect(changes).toHaveLength(2);
  });

  it("an old timeout cannot dismiss a newer plea", () => {
    const { control } = tracked();
    const first = control.requestHelpLease("b1", "first");
    control.dismissHelp("b1");
    const second = control.requestHelpLease("b1", "second");
    expect(second.requestId).not.toBe(first.requestId);
    expect(control.expireHelp("b1", first.requestId).helpReason).toBe("second");
  });

  it("a novel-length reason is cut to card size", () => {
    const { control } = tracked();
    const reason = "x".repeat(2000);
    expect(control.requestHelp("b1", reason).helpReason?.length).toBe(280);
  });

  it("release settles an open help request in the same change", () => {
    const { control } = tracked();
    control.requestHelp("b1", "stuck on a captcha");
    control.take("b1");
    const after = control.release("b1");
    expect(after).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("dismiss clears the plea without taking control", () => {
    const { control } = tracked();
    control.requestHelp("b1", "stuck");
    const after = control.dismissHelp("b1");
    expect(after.helpReason).toBeNull();
    expect(after.held).toBe(false);
  });

  it("dismiss while driving keeps the hold", () => {
    const { control } = tracked();
    control.take("b1");
    control.requestHelp("b1", "also this");
    const after = control.dismissHelp("b1");
    expect(after.held).toBe(true);
    expect(after.helpReason).toBeNull();
  });

  it("dismissing nothing is silent — no phantom broadcast", () => {
    const { control, changes } = tracked();
    control.dismissHelp("b1");
    expect(changes).toEqual([]);
  });

  it("bots are independent", () => {
    const { control } = tracked();
    control.take("b1");
    expect(control.snapshot("b2").held).toBe(false);
  });

  it("forget clears a hold and tells the listeners", () => {
    const { control, changes } = tracked();
    control.take("b1");
    control.forget("b1");
    expect(control.snapshot("b1").held).toBe(false);
    expect(changes.at(-1)?.snapshot).toEqual({ held: false, helpReason: null, heldSinceMs: null });
  });

  it("forgetting an unknown bot is silent", () => {
    const { control, changes } = tracked();
    control.forget("ghost");
    expect(changes).toEqual([]);
  });
});

describe("computerControlResourceKey", () => {
  it("keeps non-VM computers per bot", () => {
    expect(
      computerControlResourceKey({
        botId: "a",
        computer: "cloud",
        targetKey: "shared",
        hostId: "bridge-mini",
      }),
    ).toBe("bot:a");
    expect(
      computerControlResourceKey({
        botId: "a",
        computer: "local",
        targetKey: "shared",
        hostId: null,
      }),
    ).toBe("bot:a");
  });

  it("scopes a shared Local VM by host and target", () => {
    expect(
      computerControlResourceKey({
        botId: "a",
        computer: "vm",
        targetKey: "shared",
        hostId: "bridge-mini",
      }),
    ).toBe("vm:bridge-mini:shared");
    expect(
      computerControlResourceKey({
        botId: "b",
        computer: "vm",
        targetKey: "shared",
        hostId: "bridge-mini",
      }),
    ).toBe("vm:bridge-mini:shared");
  });

  it("does not transfer a hold across hosts or per-bot targets", () => {
    expect(
      computerControlResourceKey({
        botId: "a",
        computer: "vm",
        targetKey: "shared",
        hostId: "bridge-other",
      }),
    ).toBe("vm:bridge-other:shared");
    expect(
      computerControlResourceKey({
        botId: "a",
        computer: "vm",
        targetKey: "bot:aaa",
        hostId: "bridge-mini",
      }),
    ).toBe("vm:bridge-mini:bot:aaa");
    expect(
      computerControlResourceKey({
        botId: "a",
        computer: "vm",
        targetKey: "shared",
        hostId: null,
      }),
    ).toBe("vm:local:shared");
  });
});

describe("computer control shared Local VM resource", () => {
  function sharedTracked() {
    const keys: Record<string, string> = {
      b1: "vm:h1:shared",
      b2: "vm:h1:shared",
      cloud: "bot:cloud",
      otherVm: "vm:h2:shared",
    };
    const changes: Array<{ botId: string; snapshot: ControlSnapshot }> = [];
    const control = new ComputerControl(
      (botId, snapshot) => changes.push({ botId, snapshot }),
      () => clock,
      {
        resourceKeyFor: (botId) => keys[botId] ?? `bot:${botId}`,
        botsForResource: (resourceKey) =>
          Object.entries(keys)
            .filter(([, key]) => key === resourceKey)
            .map(([botId]) => botId),
      },
    );
    return { control, changes, keys };
  }

  let clock = 1000;

  it("take via one bot holds every native bot on the same resource", () => {
    clock = 1000;
    const { control, changes } = sharedTracked();
    const held = control.take("b1");
    expect(held).toEqual({ held: true, helpReason: null, heldSinceMs: 1000 });
    expect(control.snapshot("b2")).toEqual({ held: true, helpReason: null, heldSinceMs: 1000 });
    expect(control.snapshot("cloud").held).toBe(false);
    expect(control.snapshot("otherVm").held).toBe(false);
    expect(changes.map((c) => c.botId).sort()).toEqual(["b1", "b2"]);
    expect(changes.every((c) => c.snapshot.held && c.snapshot.heldSinceMs === 1000)).toBe(true);
  });

  it("a second take through a peer does not reset heldSinceMs or duplicate the hold", () => {
    clock = 1000;
    const { control, changes } = sharedTracked();
    control.take("b1");
    clock = 5000;
    changes.length = 0;
    expect(control.take("b2").heldSinceMs).toBe(1000);
    expect(changes).toEqual([]);
    expect(control.snapshot("b1").heldSinceMs).toBe(1000);
  });

  it("release through a peer restores both bots and settles help on that resource only", () => {
    clock = 1000;
    const { control, changes } = sharedTracked();
    control.requestHelp("b2", "need the keyboard");
    control.take("b1");
    expect(control.snapshot("b1").helpReason).toBeNull();
    expect(control.snapshot("b2").helpReason).toBe("need the keyboard");
    changes.length = 0;
    const after = control.release("b1");
    expect(after).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(control.snapshot("b2")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(changes.map((c) => c.botId).sort()).toEqual(["b1", "b2"]);
    expect(changes.every((c) => c.snapshot.held === false && c.snapshot.helpReason === null)).toBe(true);
  });

  it("keeps help request ids private and expiry per bot", () => {
    const { control } = sharedTracked();
    const first = control.requestHelpLease("b1", "first");
    const second = control.requestHelpLease("b2", "second");
    expect(control.snapshot("b1").helpReason).toBe("first");
    expect(control.snapshot("b2").helpReason).toBe("second");
    expect(control.expireHelp("b1", second.requestId).helpReason).toBe("first");
    expect(control.expireHelp("b2", first.requestId).helpReason).toBe("second");
    expect(control.expireHelp("b1", first.requestId).helpReason).toBeNull();
    expect(control.snapshot("b2").helpReason).toBe("second");
  });

  it("forgetting one bot does not release a still-shared hold", () => {
    const { control, changes, keys } = sharedTracked();
    control.take("b1");
    control.requestHelp("b1", "stuck");
    changes.length = 0;
    control.forget("b1");
    delete keys.b1;
    expect(control.snapshot("b1")).toEqual({ held: false, helpReason: null, heldSinceMs: null });
    expect(control.snapshot("b2").held).toBe(true);
    expect(changes).toEqual([{ botId: "b1", snapshot: { held: false, helpReason: null, heldSinceMs: null } }]);
    expect(control.release("b2").held).toBe(false);
    expect(control.snapshot("b2").held).toBe(false);
  });

  it("reassignment must not transfer a hold onto a different machine", () => {
    const { control, keys } = sharedTracked();
    control.take("b1");
    keys.b1 = "bot:b1";
    expect(control.snapshot("b1").held).toBe(false);
    expect(control.snapshot("b2").held).toBe(true);
    control.forget("b1");
    expect(control.snapshot("b2").held).toBe(true);
    keys.b2 = "vm:h2:shared";
    expect(control.snapshot("b2").held).toBe(false);
    expect(control.snapshot("otherVm").held).toBe(false);
  });
});
