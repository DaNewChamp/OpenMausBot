import type { Action, Group, Message } from "@/state/store";

import { isBotChannel } from "./bot-channel";

export type BotChannelOpenIntent = {
  group: Group;
  focusMessageId?: string;
  invokingBotId?: string;
};

export function commChipOpenIntent(
  comm: NonNullable<Message["comm"]>,
  group: Group | undefined,
  invokingBotId?: string,
): BotChannelOpenIntent | null {
  if (!group || !isBotChannel(group) || group.memberIds.length !== 2) return null;
  return { group, focusMessageId: comm.messageId, invokingBotId };
}

export function openBotChannelFromPerspective(
  dispatch: (action: Action) => void,
  group: Group,
  perspectiveBotId: string,
  focusMessageId?: string,
) {
  dispatch({
    type: "openBotChannel",
    groupId: group.id,
    perspectiveBotId,
    focusMessageId,
  });
}
