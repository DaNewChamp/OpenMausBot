import { describe, expect, it, vi } from "vitest";

import { commChipOpenIntent, openBotChannelFromPerspective } from "./bot-channel-open";

describe("comm chip navigation", () => {
  const group = {
    id: "dm",
    threadId: "thread-dm",
    name: "Alpha ⇄ Beta",
    memberIds: ["alpha", "beta"],
    dm: true,
    messages: [],
    defaultResponder: { kind: "mentions" as const },
    bulletin: "",
    unread: false,
    createdAt: 0,
  };

  it("opens the chooser for two-bot channels", () => {
    const intent = commChipOpenIntent(
      {
        groupId: "dm",
        withBotId: "beta",
        withName: "Beta",
        withColor: "green",
        messageId: "anchor-1",
      },
      group,
      "alpha",
    );
    expect(intent).toEqual({
      group,
      focusMessageId: "anchor-1",
      invokingBotId: "alpha",
    });
  });

  it("dispatches openBotChannel with perspective and focus", () => {
    const dispatch = vi.fn();
    openBotChannelFromPerspective(dispatch, group, "beta", "anchor-1");
    expect(dispatch).toHaveBeenCalledWith({
      type: "openBotChannel",
      groupId: "dm",
      perspectiveBotId: "beta",
      focusMessageId: "anchor-1",
    });
  });
});
