import type { EffortLevel } from "../../server/contracts.ts";

/** Compact size token from a model id. Clean-room mapping — not a vendor catalog. */
export type ModelSizeToken = "S" | "M" | "L" | "XL";

const SIZE_RULES: Array<{ test: RegExp; size: ModelSizeToken }> = [
  { test: /\b(mini|flash|haiku|nano|small|super)\b/i, size: "S" },
  { test: /\b(opus|max|ultra|gpt-5|grok-4)\b/i, size: "L" },
  { test: /\b(large|xl|sonnet-4)\b/i, size: "XL" },
  { test: /\b(plus|sonnet|medium|pro)\b/i, size: "M" },
];

const EFFORT_ABBREV = {
  none: "",
  low: "L",
  medium: "M",
  high: "H",
  xhigh: "XH",
  max: "MAX",
} as const satisfies Record<EffortLevel, string>;

export function modelSizeToken(model: string): ModelSizeToken {
  const id = model.trim();
  if (!id) return "M";
  for (const rule of SIZE_RULES) {
    if (rule.test.test(id)) return rule.size;
  }
  // Short ids (one token, no family hint) read as the small desk default.
  if (!id.includes("-") && id.length <= 8) return "S";
  return "M";
}

function isEffortAbbrevKey(value: string): value is Exclude<EffortLevel, "none"> {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

export function effortAbbrev(effort?: EffortLevel | string | null): string {
  if (!effort || effort === "none") return "";
  if (!isEffortAbbrevKey(effort)) return "";
  return EFFORT_ABBREV[effort];
}

/** "S-M", "L-XH" — name-line suffix used in the left rail and chat header. */
export function modelSuffix(selection: {
  model?: string | null;
  effort?: EffortLevel | string | null;
}): string {
  const size = modelSizeToken(selection.model ?? "");
  const effort = effortAbbrev(selection.effort);
  return effort ? `${size}-${effort}` : size;
}

export function conversationTitle(
  name: string,
  selection: { model?: string | null; effort?: EffortLevel | string | null },
): string {
  const suffix = modelSuffix(selection);
  const trimmed = name.trim() || "Bot";
  return suffix ? `${trimmed} \u00b7 ${suffix}` : trimmed;
}
