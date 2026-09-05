export type LocalVmSettingsMode = "shared" | "per-bot";
export type LocalVmSettingsAction = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

/** Per-bot lifecycle must never fall back to the first bot or shared target. */
export function localVmSettingsBotId(input: {
  bots: ReadonlyArray<{ id: string }>;
  selectedId: string;
  explicitBotId?: string;
  mode: LocalVmSettingsMode;
}): string | null {
  if (input.explicitBotId !== undefined) {
    return input.bots.find((bot) => bot.id === input.explicitBotId)?.id ?? null;
  }
  const selected = input.bots.find((bot) => bot.id === input.selectedId);
  return selected?.id ?? (input.mode === "shared" ? input.bots[0]?.id ?? null : null);
}

/** Use the hub's existing guarded, target-scoped lifecycle endpoints. */
export function localVmSettingsActionPath(input: {
  botId: string | null;
  mode: LocalVmSettingsMode;
  action: LocalVmSettingsAction;
  pairedClient?: boolean;
}): string {
  if (input.pairedClient) {
    if (input.action === "pull" || input.action === "remove") {
      throw new Error("Image preparation and container removal are managed in desktop Settings.");
    }
    if (!input.botId) throw new Error("Choose a bot before managing its browser container.");
    const action = input.action === "start" ? "run" : input.action;
    return `/api/bots/${encodeURIComponent(input.botId)}/local-computer/${action}`;
  }
  if (input.action === "pull") return "/api/local-computer/pull";
  if (input.mode === "per-bot") {
    if (!input.botId) throw new Error("Choose a bot before managing its browser container.");
    const action = input.action === "start" ? "run" : input.action;
    return `/api/bots/${encodeURIComponent(input.botId)}/local-computer/${action}`;
  }
  // The generic start path does not relay; run does and safely reuses a
  // stopped compatible container on the selected fleet machine.
  const action = input.action === "start" ? "run" : input.action;
  return `/api/local-computer/${action}`;
}

export function localVmContainerExists(status: { container?: string } | null | undefined): boolean {
  return status?.container === "running" || status?.container === "stopped";
}
