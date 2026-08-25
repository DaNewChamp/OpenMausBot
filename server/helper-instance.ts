// Borrowing an engine for a short, non-conversational question.
//
// Some harness features need a model to answer one small thing — "would a
// person have obviously approved this?", "what is worth remembering from
// this?" — and that is what `generateText` on ProviderInstance is for. It is
// optional, and only some drivers implement it, so a bot running on codex or
// an ACP engine has to borrow a sibling instance or go without.
//
// Everything here fails to null on purpose. A feature built on this must
// degrade to OFF, never to a guess: a classifier that cannot be reached has
// no opinion, and no opinion means do the cautious thing.

export interface HelperCapable {
  readonly instanceId: string;
  /** Present only on drivers that can answer a one-shot prompt. */
  readonly generateText?: (prompt: string) => Promise<string>;
}

const canAnswer = (instance: HelperCapable): boolean => instance.generateText !== undefined;

/** The bot's own engine first — it is the one the user chose and pays for,
 * and keeping the work there avoids surprising them with traffic on an engine
 * they did not pick for this bot. Any capable sibling otherwise. */
export function resolveHelper(
  preferredId: string | undefined,
  all: readonly HelperCapable[],
): HelperCapable | null {
  const preferred = preferredId === undefined ? undefined : all.find((i) => i.instanceId === preferredId);
  if (preferred && canAnswer(preferred)) return preferred;
  return all.find(canAnswer) ?? null;
}

/** Ask, under a deadline. Null means "no usable answer" for every reason
 * there can be one: the instance cannot generate, the call failed, it took
 * too long, or it came back empty. The caller does not need to tell those
 * apart — all four mean the same thing to it. */
export async function askHelper(
  helper: HelperCapable,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const generate = helper.generateText;
  if (!generate) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The slow call is abandoned, not cancelled: a CLI mid-answer has no
    // cancel, and leaving the caller blocked on it would stall a turn.
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    // the race resolves to the engine's string, or to null from the deadline
    const answer = await Promise.race([generate(prompt), timeout]);
    if (answer === null) return null;
    const text = answer.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
