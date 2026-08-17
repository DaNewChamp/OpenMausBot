// Landing on a message: after a search hit, scroll the row into view and
// flash it. Rows are wrapped in `display: contents` (no box of their own),
// so the wrapper carries data-mid and its last child — the bubble/chip,
// after any day separator — is what gets scrolled and highlighted.
import { useEffect } from "react";
import { useStore } from "@/state/store";

const FLASH_CLASSES = ["ring-2", "ring-accent/70", "rounded-2xl", "transition-shadow"];

export function useFocusMessage(threadId: string, ready: boolean) {
  const { state } = useStore();
  const focus = state.focusMessage;
  useEffect(() => {
    if (!focus || focus.threadId !== threadId || !ready) return;
    // messages may land a tick after the task switch; try briefly
    let tries = 0;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      const wrapper = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focus.messageId)}"]`);
      const target = wrapper?.lastElementChild as HTMLElement | null;
      if (!target) {
        if (tries++ < 20) setTimeout(attempt, 100);
        return;
      }
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add(...FLASH_CLASSES);
      flashTimer = setTimeout(() => target.classList.remove(...FLASH_CLASSES), 1800);
    };
    attempt();
    return () => {
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [focus?.nonce, focus?.threadId, focus?.messageId, threadId, ready]);
}
