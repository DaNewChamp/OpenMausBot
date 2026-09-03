/** Hub-wide house style: one voice instruction block prepended to every
 * bot's prompt, whatever engine it runs on. The hub owner edits the text in
 * settings; a bot's own instructions win when they say otherwise — an
 * explicit opt-out marker line in the bot's own instructions suppresses the
 * block entirely for that bot. */
import { houseStyleEnabled, houseStyleInstructions, type AppConfig } from "./config.ts";

/** A bot whose own instructions contain this line gets no house style. */
export const HOUSE_STYLE_OPT_OUT_MARKER = "[house-style: off]";

function botOptedOut(botInstructions: string | undefined | null): boolean {
  if (!botInstructions) return false;
  return botInstructions
    .split("\n")
    .some((line) => line.trim() === HOUSE_STYLE_OPT_OUT_MARKER);
}

/** The prepended block, or "" when house style is off, the bot opted out,
 * or the effective instructions text is empty. */
export function houseStylePreamble(cfg: AppConfig, botInstructions: string | undefined | null): string {
  if (!houseStyleEnabled(cfg)) return "";
  if (botOptedOut(botInstructions)) return "";
  const text = houseStyleInstructions(cfg);
  if (!text) return "";
  return [
    "--- House style (how every bot in this hub sounds) ---",
    text,
    "--- end house style ---",
    "",
  ].join("\n");
}
