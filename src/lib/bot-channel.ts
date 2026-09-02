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
export const COMPANION_SHOW_BOT_CHANNELS_KEY = "companion.showBotChannels";

export function participantOrder(memberIds: string[], invokingBotId?: string | null): string[] {
  if (memberIds.length !== 2 || !invokingBotId || !memberIds.includes(invokingBotId)) {
    return memberIds;
  }
  return [invokingBotId, memberIds.find((id) => id !== invokingBotId)!];
}

export function perspectiveTitle(
  group: { id: string; memberIds: string[]; dm?: boolean },
  perspective: { roomId: string; botId: string } | null,
  botName: (id: string) => string | undefined,
): string | null {
  if (!isBotChannel(group) || !perspective || perspective.roomId !== group.id) return null;
  const lead = botName(perspective.botId);
  const otherId = group.memberIds.find((id) => id !== perspective.botId);
  const other = otherId ? botName(otherId) : undefined;
  if (!lead || !other) return null;
  return `${lead} ⇄ ${other}`;
}

export function loadShowBotChannels(storage: Storage | null | undefined = globalThis.localStorage): boolean {
  try {
    if (storage?.getItem(SHOW_BOT_CHANNELS_KEY) === "1") return true;
    const companion = storage?.getItem(COMPANION_SHOW_BOT_CHANNELS_KEY);
    return companion === "1" || companion === "true";
  } catch {
    return false;
  }
}

export function saveShowBotChannels(
  show: boolean,
  storage: Storage | null | undefined = globalThis.localStorage,
): void {
  try {
    if (show) {
      storage?.setItem(SHOW_BOT_CHANNELS_KEY, "1");
      storage?.setItem(COMPANION_SHOW_BOT_CHANNELS_KEY, "true");
    } else {
      storage?.removeItem(SHOW_BOT_CHANNELS_KEY);
      storage?.removeItem(COMPANION_SHOW_BOT_CHANNELS_KEY);
    }
  } catch {
    // Private browsing may reject localStorage; preference stays in-memory only.
  }
}
