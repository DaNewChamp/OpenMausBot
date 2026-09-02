import { ChevronRight } from "lucide-react";

import { MausAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { participantOrder } from "@/lib/bot-channel";
import { useStore, type Bot, type Group } from "@/state/store";

export function BotChannelChooser({
  group,
  invokingBotId,
  onSelect,
  onClose,
}: {
  group: Group;
  invokingBotId?: string;
  onSelect: (botId: string) => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const members = participantOrder(group.memberIds, invokingBotId)
    .map((id) => state.bots.find((bot) => bot.id === id))
    .filter((bot): bot is Bot => Boolean(bot));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-labelledby="bot-channel-chooser-title"
        aria-describedby="bot-channel-chooser-desc"
        className="w-full max-w-sm rounded-2xl border border-hairline/50 bg-panel shadow-xl"
      >
        <div className="border-b border-hairline/40 px-4 py-3">
          <h2 id="bot-channel-chooser-title" className="text-[15px] font-semibold text-ink">
            Bot conversation
          </h2>
          <p id="bot-channel-chooser-desc" className="mt-1 text-[12.5px] text-ink-secondary">
            Both bots share one transcript. Choose whose perspective to open from.
          </p>
        </div>
        <ul className="p-2">
          {members.map((bot) => (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() => onSelect(bot.id)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-raised"
                aria-label={`${bot.name}, open shared conversation`}
              >
                <MausAvatar
                  color={bot.color}
                  state={normalizeState(bot.mascotExpression) ?? "happy"}
                  size={36}
                  animated={false}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{bot.name}</span>
                  <span className="block text-[12px] text-ink-secondary">Open shared conversation</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-ink-secondary" />
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-hairline/40 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
