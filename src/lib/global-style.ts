export const GLOBAL_STYLE_SECTION_TITLE = "Global style";
export const GLOBAL_STYLE_SECTION_FOOTER =
  "Applies to every bot unless overridden in that bot's profile instructions.";
export const GLOBAL_STYLE_INSTRUCTIONS_LABEL = "Global style instructions";

export function globalStyleIsOptedOut(instructions?: string | null): boolean {
  if (!instructions) return false;
  return instructions.split(/\r?\n/).some((line) => {
    const trimmed = line.trim().toLowerCase();
    return (
      trimmed === "[house-style: off]" ||
      trimmed === "[global-style: off]" ||
      trimmed === "global style: off" ||
      trimmed === "house style: off"
    );
  });
}

export function globalStyleStripOptOutMarkers(instructions?: string | null): string {
  if (!instructions) return "";
  const lines = instructions.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim().toLowerCase();
    return (
      trimmed !== "[house-style: off]" &&
      trimmed !== "[global-style: off]" &&
      trimmed !== "global style: off" &&
      trimmed !== "house style: off"
    );
  });
  return lines.join("\n").trim();
}

export function globalStyleComposeInstructions(userText: string, applyGlobalStyle: boolean): string {
  const cleaned = globalStyleStripOptOutMarkers(userText);
  if (applyGlobalStyle) {
    return cleaned;
  }
  return cleaned ? `${cleaned}\n[house-style: off]` : "[house-style: off]";
}

export function globalStyleApplies(
  config?: { houseStyle?: { enabled?: boolean; instructions?: string } } | null,
  instructions?: string | null,
): boolean {
  if (config?.houseStyle?.enabled === false) return false;
  return !globalStyleIsOptedOut(instructions);
}

export function globalStyleStatusDescription(
  config?: { houseStyle?: { enabled?: boolean; instructions?: string } } | null,
  instructions?: string | null,
): string {
  if (config?.houseStyle?.enabled === false) {
    return "Global style is turned off in Settings.";
  }
  if (globalStyleIsOptedOut(instructions)) {
    return "Global style is turned off for this bot.";
  }
  return "Global style applies to this bot.";
}
