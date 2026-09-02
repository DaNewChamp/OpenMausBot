import { describe, expect, it } from "vitest";

import {
  isBotChannel,
  loadShowBotChannels,
  rosterGroups,
  saveShowBotChannels,
  SHOW_BOT_CHANNELS_KEY,
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
});
