import { describe, expect, it } from "vitest";

import { unreadConversationCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible bot and room conversations but ignores archived bots", () => {
    expect(
      unreadConversationCount(
        [{ unread: true }, { unread: false }, { unread: true, hidden: true }],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(2);
  });

  it("excludes hidden bot channels from the badge unless they are shown", () => {
    const groups = [
      { unread: true, dm: false },
      { unread: true, dm: true },
    ];
    expect(unreadConversationCount([], groups, false)).toBe(1);
    expect(unreadConversationCount([], groups, true)).toBe(2);
  });
});
