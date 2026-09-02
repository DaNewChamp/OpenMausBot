import { rosterGroups } from "./bot-channel";

export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean }>,
  groups: Array<{ unread?: boolean; dm?: boolean }>,
  showBotChannels = false,
): number {
  const visibleGroups = rosterGroups(groups, showBotChannels);
  return (
    bots.filter((bot) => !bot.hidden && bot.unread).length + visibleGroups.filter((group) => group.unread).length
  );
}
