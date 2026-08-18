// What to DO about a bot repeating itself, given what the harness can do
// for its engine. Detection (repeat-detector.ts) counts; this decides. Kept
// pure so the escalation is testable without a bus.
//
//   5×, 10× — a chip for the human, and, on an engine that takes a message
//             mid-turn (capabilities.queueing), a nudge steered into the
//             turn: the model reads it before its next call and, in
//             practice, breaks the loop. Engines without steer get the chip.
//   20×      — stop the turn. At that point it is only spending money.
//
// Per-call deadlines are deliberately absent: for CLI engines the harness
// does not own the call, so the only honest deadline is "stop the turn",
// and the stall watchdog already does that on silence.

export const REPEAT_THRESHOLDS = [5, 10, 20] as const;
export const REPEAT_STOP_AT = 20;

export interface RepeatAction {
  /** the chip for the human, always */
  chip: string;
  /** a note to steer into the running turn — only when the engine can take one */
  steer?: string;
  /** end the turn */
  stop?: boolean;
}

export function repeatAction(input: { threshold: number; tool: string; args: string; canSteer: boolean }): RepeatAction {
  const { threshold, tool, args, canSteer } = input;
  const call = `${tool}: ${args.slice(0, 80)}${args.length > 80 ? "…" : ""}`;
  if (threshold >= REPEAT_STOP_AT) {
    return {
      chip: `error: stopped — the same call repeated ${threshold}× (${call})`,
      stop: true,
    };
  }
  const chip = canSteer
    ? `Same call repeated ${threshold}× — ${call} — nudged the bot to change approach`
    : `Same call repeated ${threshold}× — ${call} — it may be stuck`;
  const steer = canSteer
    ? [
        `OpenMausBot: you have now run the same call ${threshold} times with the same arguments (${call}).`,
        `Stop repeating it. If it is not giving you what you need, change approach, or explain what is blocking you and ask the user.`,
        `If it keeps repeating, the turn will be stopped at ${REPEAT_STOP_AT}.`,
      ].join(" ")
    : undefined;
  return { chip, ...(steer ? { steer } : {}) };
}
