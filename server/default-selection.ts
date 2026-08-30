// Default engine for a new bot / empty-store seed.
//
// A send uses the bot's persisted `modelSelection` unless fast mode is on.
// This function only answers "what should a brand-new bot start on?"
// Fast mode already prefers Codex (`server/fast-routing.ts`); new-bot
// inference must do the same so pairing a phone does not land on a stale
// Claude OAuth session while Cursor (the tool layer) sits on PATH.
import type { ModelSelection } from "./contracts.ts";

export interface DefaultSelectionInstance {
  instanceId: string;
  driverKind: string;
  snapshot: { state: string };
  models?: { default?: string };
}

export function defaultModelSelection(
  described: readonly DefaultSelectionInstance[],
): ModelSelection {
  const available = described.filter((row) => row.snapshot.state === "available");
  // Deliberately no fallback to an unavailable row. A missing CLI must stay
  // an empty selection so the UI shows setup instead of a bot that spawn-
  // fails on the first send.
  const pick =
    available.find((row) => row.driverKind === "codex") ??
    available.find((row) => row.driverKind !== "cursorAgent") ??
    available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models?.default ?? "" };
}
