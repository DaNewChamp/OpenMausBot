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
  private readonly maxPerTurn: number;
  private counts = new Map<string, number>();

  constructor(maxPerTurn = 4) {
    this.maxPerTurn = maxPerTurn;
  }

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

export const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

export interface HermesCommReplayClock {
  now(): number;
}

export interface HermesCommReplayOptions {
  ttlMs?: number;
  clock?: HermesCommReplayClock;
  cleanupLimit?: number;
}

export class HermesCommReplay {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly clock: HermesCommReplayClock;
  private readonly cleanupLimit: number;

  constructor(options: HermesCommReplayOptions = {}) {
    this.ttlMs = options.ttlMs ?? REPLAY_TTL_MS;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.cleanupLimit = options.cleanupLimit ?? 64;
  }

  remember(deliveryKey: string): boolean {
    this.evictExpired();
    const now = this.clock.now();
    const seenAt = this.seen.get(deliveryKey);
    if (seenAt !== undefined && now - seenAt < this.ttlMs) return false;
    this.seen.set(deliveryKey, now);
    return true;
  }

  /** @internal test seam for bounded cleanup assertions */
  sizeForTests(): number {
    return this.seen.size;
  }

  private evictExpired(): void {
    const now = this.clock.now();
    let removed = 0;
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt < this.ttlMs) continue;
      this.seen.delete(key);
      removed += 1;
      if (removed >= this.cleanupLimit) break;
    }
  }
}
