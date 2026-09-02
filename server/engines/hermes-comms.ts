import { createHash } from "node:crypto";

export type HermesCommPlane = "vbot" | "hermesMessageAgent";

export interface HermesCommAttribution {
  plane: HermesCommPlane;
  fromBotId: string;
  toBotId: string;
  deliveryKey: string;
}

export interface HermesCommCandidate {
  plane: HermesCommPlane;
  fromBotId: string;
  toBotId: string;
  text: string;
  turnId: string;
  deliveryKey: string;
}

export const MESSAGE_AGENT_MAX_CHARS = 16_000;

export function deliveryKey(input: {
  fromBotId: string;
  toBotId: string;
  turnId: string;
  text: string;
}): string {
  return createHash("sha256")
    .update(`${input.fromBotId}\0${input.toBotId}\0${input.turnId}\0${input.text}`)
    .digest("hex");
}

export function resolveLocalTarget(target: string, roster: ReadonlyMap<string, string>): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(target)) return null;
  return roster.get(target.toLowerCase()) ?? null;
}

export function normalizeMessageAgentBody(
  text: string,
): { ok: true; text: string } | { ok: false; reason: "too_long" | "empty" } {
  if (text.length === 0 || text.trim().length === 0) return { ok: false, reason: "empty" };
  if (text.length > MESSAGE_AGENT_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

export class HermesCommBudget {
  constructor(private readonly maxPerTurn = 4) {}
  private counts = new Map<string, number>();

  tryConsume(turnId: string): boolean {
    const next = (this.counts.get(turnId) ?? 0) + 1;
    if (next > this.maxPerTurn) return false;
    this.counts.set(turnId, next);
    return true;
  }

  releaseTurn(turnId: string): void {
    this.counts.delete(turnId);
  }
}

export class HermesCommReplay {
  private readonly seen = new Set<string>();

  remember(deliveryKey: string): boolean {
    if (this.seen.has(deliveryKey)) return false;
    this.seen.add(deliveryKey);
    return true;
  }
}
