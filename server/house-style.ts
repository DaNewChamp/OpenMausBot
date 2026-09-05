/** Hub-wide house style: one voice instruction block prepended to every
 * bot's prompt, whatever engine it runs on. The hub owner edits the text in
 * settings; a bot's own instructions win when they say otherwise — an
 * explicit opt-out marker line in the bot's own instructions suppresses the
 * block entirely for that bot. */
import { houseStyleEnabled, houseStyleInstructions, type AppConfig } from "./config.ts";

/** A bot whose own instructions contain this line gets no house style. */
export const HOUSE_STYLE_OPT_OUT_MARKER = "[house-style: off]";
export const GLOBAL_STYLE_OPT_OUT_MARKER = "[global-style: off]";

function botOptedOut(botInstructions: string | undefined | null): boolean {
  if (!botInstructions) return false;
  return botInstructions
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim().toLowerCase();
      return (
        trimmed === HOUSE_STYLE_OPT_OUT_MARKER.toLowerCase() ||
        trimmed === GLOBAL_STYLE_OPT_OUT_MARKER.toLowerCase() ||
        trimmed === "global style: off" ||
        trimmed === "house style: off"
      );
    });
}

function hasExistingStylePreamble(botInstructions: string | undefined | null): boolean {
  if (!botInstructions) return false;
  return (
    botInstructions.includes("--- House style (how every bot in this hub sounds) ---") ||
    botInstructions.includes("--- Global style")
  );
}

/** The prepended block, or "" when house style is off, the bot opted out,
 * or the effective instructions text is empty. */
export function houseStylePreamble(cfg: AppConfig, botInstructions: string | undefined | null): string {
  if (!houseStyleEnabled(cfg)) return "";
  if (botOptedOut(botInstructions)) return "";
  if (hasExistingStylePreamble(botInstructions)) return "";
  const text = houseStyleInstructions(cfg);
  if (!text) return "";
  return [
    "--- House style (how every bot in this hub sounds) ---",
    text,
    "--- end house style ---",
    "",
  ].join("\n");
}

export const globalStylePreamble = houseStylePreamble;
