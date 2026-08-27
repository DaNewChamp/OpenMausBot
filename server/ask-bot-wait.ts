// Synchronous half of ask_bot: wait for a peer's turn.completed, then
// return its assistant text. The wait has a hard ceiling so a long-running
// specialist cannot pin the caller's turn; hitting that ceiling is NOT a
// failure. The target keeps working, the caller gets a still-working note,
// and late turn.completed is delivered through onLateComplete (the harness
// mirrors it into the A⇄B channel).

import type { RuntimeEvent, RuntimeEventListener } from "./contracts.ts";

export const ASK_BOT_WAIT_MS = 4 * 60_000;

/** The old ceiling used to invent this as the peer's reply. Tests pin that
 * we never return it: a live target is still working, not timed out. */
export const ASK_BOT_TIMEOUT_FAILURE = "(timed out waiting for the bot to reply)";

export function askBotStillWorkingNote(botName: string): string {
  return `@${botName} is still working. This is not a failure. Their reply will appear in the conversation when they finish. Continue with the user; do not claim the work is complete.`;
}

export function askBotStillWorkingChip(botName: string): string {
  return `@${botName} is still working`;
}

export function askBotFinishedChip(botName: string): string {
  return `@${botName} finished`;
}

export function askBotFailedChip(botName: string): string {
  return `@${botName} did not finish`;
}

export type AskBotWaitStatus = "completed" | "pending" | "failed";

export type AskBotWaitResult =
  | { status: "completed"; text: string }
  | { status: "pending"; text: string; partial: string }
  | { status: "failed"; text: string };

export interface AskBotWaitBus {
  subscribe(listener: RuntimeEventListener): () => void;
}

export interface AskBotWaitStart {
  fail(reason: string): void;
}

export interface AskBotLateResult {
  ok: boolean;
  text: string;
}

export interface AskBotWaitOptions {
  bus: AskBotWaitBus;
  threadId: string;
  start: (ctl: AskBotWaitStart) => void | Promise<void>;
  /** Override for tests. Production uses ASK_BOT_WAIT_MS. */
  timeoutMs?: number;
  /** Called synchronously when the wait ceiling hits, before the promise
   * resolves as pending. Register channel watches and still-working chips
   * here so a turn.completed in the same tick cannot slip through. */
  onPending?: (cancelLateWatch: () => void) => void;
  /** Exposes the same fail control used by start(), so the harness can
   * terminate an in-flight wait when the provider fleet disappears before
   * the pending ceiling creates a durable channel watch. */
  onControl?: (ctl: AskBotWaitStart) => void;
  /** Target finished (or failed to start) after the wait already resolved
   * as pending. The caller must deliver this into the conversation. */
  onLateComplete?: (result: AskBotLateResult) => void;
}

export function waitForAskBotReply(opts: AskBotWaitOptions): Promise<AskBotWaitResult> {
  const timeoutMs = opts.timeoutMs ?? ASK_BOT_WAIT_MS;
  const stillWorking = askBotStillWorkingNote("the bot");
  return new Promise((resolve) => {
    let text = "";
    let syncSettled = false;
    let watching = true;

    const unsub = opts.bus.subscribe((event: RuntimeEvent) => {
      if (!watching || event.threadId !== opts.threadId) return;
      if (event.type === "item.completed" && event.itemType === "assistant_text") {
        text += (text ? "\n" : "") + event.text;
        return;
      }
      if (event.type !== "turn.completed") return;
      settleTurn(event.ok);
    });

    const stopWatching = () => {
      watching = false;
      unsub();
    };

    const finish = (result: AskBotWaitResult) => {
      if (syncSettled) return;
      syncSettled = true;
      clearTimeout(timer);
      if (result.status !== "pending") stopWatching();
      resolve(result);
    };

    const settleTurn = (ok: boolean) => {
      if (!watching) return;
      if (!syncSettled) {
        const reply = text || (ok ? "(the bot finished without a text reply)" : "(the bot did not finish)");
        finish({ status: ok ? "completed" : "failed", text: reply });
        return;
      }
      stopWatching();
      opts.onLateComplete?.({ ok, text });
    };

    const failStart = (reason: string) => {
      const message = `(couldn't start that bot: ${reason})`;
      if (!syncSettled) {
        finish({ status: "failed", text: message });
        return;
      }
      if (!watching) return;
      stopWatching();
      opts.onLateComplete?.({ ok: false, text: "" });
    };

    const timer = setTimeout(() => {
      if (syncSettled) return;
      try {
        opts.onPending?.(stopWatching);
      } catch (error) {
        console.error("ask-bot-wait: onPending threw", error);
      }
      finish({ status: "pending", text: stillWorking, partial: text });
    }, timeoutMs);
    timer.unref?.();

    try {
      const control = { fail: failStart };
      opts.onControl?.(control);
      const started = opts.start(control);
      if (started && typeof started.then === "function") {
        void started.catch((error: unknown) => {
          failStart(error instanceof Error ? error.message : String(error));
        });
      }
    } catch (error) {
      failStart(error instanceof Error ? error.message : String(error));
    }
  });
}
