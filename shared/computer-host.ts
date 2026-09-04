/** Paired desktop/bridge id a bot's computer is pinned to. */
export const COMPUTER_HOST_ID_PATTERN = /^[\w-]{1,80}$/;

export function parseComputerHostId(
  value: unknown,
): { ok: true; computerHostId?: string | null } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (value === null || value === "") return { ok: true, computerHostId: null };
  if (typeof value !== "string" || !COMPUTER_HOST_ID_PATTERN.test(value)) {
    return { ok: false, error: "computerHostId must be a paired machine id" };
  }
  return { ok: true, computerHostId: value };
}
