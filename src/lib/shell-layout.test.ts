import { describe, expect, it } from "vitest";

import {
  conversationNavOrder,
  leftRailWidthPx,
  loadRightRailOpen,
  neighborConversationId,
  parseRightRailOpen,
  saveRightRailOpen,
  SHELL_COLLAPSE_LEFT_BELOW,
  SHELL_COLLAPSE_RIGHT_BELOW,
  SHELL_LEFT_ICONS_PX,
  SHELL_LEFT_WIDTH_PX,
  SHELL_SCREENSHOT_HEIGHT,
  SHELL_SCREENSHOT_WIDTH,
  shellColumnVisibility,
  unreadAfterSelected,
} from "./shell-layout";

describe("shell column collapse policy", () => {
  it("keeps three columns at the phase-1 screenshot size", () => {
    const vis = shellColumnVisibility(SHELL_SCREENSHOT_WIDTH, {
      leftDensity: "compact",
      rightUserCollapsed: false,
    });
    expect(SHELL_SCREENSHOT_WIDTH).toBe(1024);
    expect(SHELL_SCREENSHOT_HEIGHT).toBe(648);
    expect(vis.right).toBe("open");
    expect(vis.left).toBe("open");
    expect(vis.collapseOrder).toEqual(["right", "left"]);
  });

  it("collapses the right rail before the left rail", () => {
    const mid = shellColumnVisibility(SHELL_COLLAPSE_RIGHT_BELOW - 1, {
      leftDensity: "compact",
      rightUserCollapsed: false,
    });
    expect(mid.right).toBe("hidden");
    expect(mid.left).toBe("open");

    const narrow = shellColumnVisibility(SHELL_COLLAPSE_LEFT_BELOW - 1, {
      leftDensity: "compact",
      rightUserCollapsed: false,
    });
    expect(narrow.right).toBe("hidden");
    expect(narrow.left).toBe("overlay");
  });

  it("honors a user-collapsed right rail even on a wide window", () => {
    const vis = shellColumnVisibility(1400, {
      leftDensity: "icons",
      rightUserCollapsed: true,
    });
    expect(vis.right).toBe("hidden");
    expect(vis.left).toBe("icons");
    expect(leftRailWidthPx(vis.left, "icons")).toBe(SHELL_LEFT_ICONS_PX);
    expect(leftRailWidthPx("open", "compact")).toBe(SHELL_LEFT_WIDTH_PX);
  });

  it("defaults the right rail open and round-trips storage", () => {
    expect(parseRightRailOpen(null)).toBe(true);
    expect(parseRightRailOpen("closed")).toBe(false);
    const store: Record<string, string> = {};
    saveRightRailOpen(false, { setItem: (key, value) => { store[key] = value; } });
    expect(loadRightRailOpen({ getItem: (key) => store[key] ?? null })).toBe(false);
  });
});

describe("conversation navigation policy", () => {
  it("walks visible bots after rooms and wraps", () => {
    const rows = conversationNavOrder(
      [
        { id: "a" },
        { id: "hidden", hidden: true },
        { id: "b" },
      ],
      [{ id: "room" }],
    );
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(["room", "a", "b"]);
    expect(neighborConversationId(ids, "a", 1)).toBe("b");
    expect(neighborConversationId(ids, "b", 1)).toBe("room");
    expect(neighborConversationId(ids, "room", -1)).toBe("b");
  });

  it("lists unread rows below the current selection", () => {
    const unread = unreadAfterSelected(
      [
        { id: "chief", unread: false },
        { id: "risk", unread: true },
        { id: "poly", unread: true },
      ],
      "chief",
    );
    expect(unread.map((row) => row.id)).toEqual(["risk", "poly"]);
  });
});
