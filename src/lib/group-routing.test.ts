import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { groupComposerHint, roomRespondersForComposer } from "./group-routing";

describe("roomRespondersForComposer", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(
      roomRespondersForComposer("hello there", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(
      roomRespondersForComposer("@Milind take this", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "everyone" } })).toEqual(members);
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "mentions" } })).toEqual([]);
    expect(roomRespondersForComposer("@everyone hello", members, { defaultResponder: { kind: "mentions" } })).toEqual(
      members,
    );
  });

  it("mentions-only rooms use the composer hint copy", () => {
    const room = {
      id: "g1",
      threadId: "t1",
      name: "Ops",
      memberIds: ["atlas", "milind"],
      defaultResponder: { kind: "mentions" as const },
      bulletin: "",
      unread: false,
      createdAt: 0,
      dm: false,
      messages: [],
    };
    expect(groupComposerHint(room, members as Bot[])).toBe("@mention a bot");
  });
});

