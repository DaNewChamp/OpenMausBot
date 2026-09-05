/** Paired clients may take the bot's assigned Local VM, not the host desktop. */
export function computerControlPath(botId: string, computer: string | undefined, paired: boolean): string | null {
  if (paired && computer !== "vm") return null;
  const scope = paired ? "local-computer" : "computer";
  return `/api/bots/${encodeURIComponent(botId)}/${scope}/control`;
}
