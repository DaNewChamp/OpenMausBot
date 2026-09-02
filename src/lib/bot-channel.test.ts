import { describe, expect, it } from "vitest";

import {
  isBotChannel,
  loadShowBotChannels,
  participantOrder,
  perspectiveTitle,
  rosterGroups,
  saveShowBotChannels,
  SHOW_BOT_CHANNELS_KEY,
  COMPANION_SHOW_BOT_CHANNELS_KEY,
} from "./bot-channel";

describe("bot-channel roster policy", () => {
  const groups = [
    { id: "team", name: "Team", dm: false },
    { id: "alpha-beta", name: "Alpha ⇄ Beta", dm: true },
  ];

  it("recognizes auto-created bot channels", () => {
    expect(isBotChannel(groups[1]!)).toBe(true);
    expect(isBotChannel(groups[0]!)).toBe(false);
  });

  it("hides bot channels from the roster by default", () => {
    expect(rosterGroups(groups, false).map((group) => group.id)).toEqual(["team"]);
  });

  it("shows bot channels when the preference is enabled", () => {
    expect(rosterGroups(groups, true).map((group) => group.id)).toEqual(["team", "alpha-beta"]);
  });

  it("orders participants with the invoking bot first", () => {
    expect(participantOrder(["alpha", "beta"], "beta")).toEqual(["beta", "alpha"]);
  });

  it("builds a scoped perspective title", () => {
    const title = perspectiveTitle(
      { id: "dm", memberIds: ["alpha", "beta"], dm: true },
      { roomId: "dm", botId: "beta" },
      (id) => (id === "alpha" ? "Alpha" : id === "beta" ? "Beta" : undefined),
    );
    expect(title).toBe("Beta ⇄ Alpha");
  });
});

describe("show bot channels preference", () => {
  it("defaults to hidden and round-trips through storage", () => {
    const storage = new Map<string, string>();
    const target = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    } as Storage;

    expect(loadShowBotChannels(target)).toBe(false);
    saveShowBotChannels(true, target);
    expect(storage.get(SHOW_BOT_CHANNELS_KEY)).toBe("1");
    expect(loadShowBotChannels(target)).toBe(true);
    saveShowBotChannels(false, target);
    expect(loadShowBotChannels(target)).toBe(false);
  });

  it("reads the companion preference key for cross-client parity", () => {
    const storage = new Map<string, string>();
    const target = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    } as Storage;

    storage.set(COMPANION_SHOW_BOT_CHANNELS_KEY, "true");
    expect(loadShowBotChannels(target)).toBe(true);
  });
});
