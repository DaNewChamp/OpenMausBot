/** Auto-created bot⇄bot channels (`group.dm === true`). */
export function isBotChannel(group: { dm?: boolean }): boolean {
  return group.dm === true;
}

/** Roster-visible groups. Bot channels stay hidden unless the user opts in. */
export function rosterGroups<T extends { dm?: boolean }>(groups: T[], showBotChannels: boolean): T[] {
  if (showBotChannels) return groups;
  return groups.filter((group) => !isBotChannel(group));
}

export const SHOW_BOT_CHANNELS_KEY = "omb.showBotChannels";

export function loadShowBotChannels(storage: Storage | null | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SHOW_BOT_CHANNELS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowBotChannels(
  show: boolean,
  storage: Storage | null | undefined = globalThis.localStorage,
): void {
  try {
    if (show) storage?.setItem(SHOW_BOT_CHANNELS_KEY, "1");
    else storage?.removeItem(SHOW_BOT_CHANNELS_KEY);
  } catch {
    // Private browsing may reject localStorage; preference stays in-memory only.
  }
}
