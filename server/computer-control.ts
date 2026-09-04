// Who is driving a computer — the person or the bot. Holds live in the
// harness because every consumer (the panel, the SSE stream, and the
// per-turn computer proxies) already talks to it.
//
// The rules this module exists to enforce:
//   - A bot can only ASK for hands (`requestHelp`); it can never take
//     control, and it cannot clear a hold. Only the person takes and
//     releases, from the computer panel.
//   - While the person holds control, the bot's computer actions are
//     REFUSED by the proxies, not queued. A queued click would land after
//     the person has moved on, on whatever happens to be under it.
//   - Releasing control also settles any open help request, so a bot
//     waiting on `requestHelp` wakes up from the same state change the
//     person made — there is no separate "done helping" step to forget.
//   - A hold is one fact about one computer resource. Native bots that
//     share a Local VM share that hold; help requests stay per-bot.
//
// State is per-boot and in-memory on purpose: a hold is a live fact about
// who is at the screen right now, and surviving a harness restart would
// mean a stale hold silently bricking a bot's computer.

export interface ControlSnapshot {
  /** True while the person is driving; the bot's hands are refused. */
  held: boolean;
  /** The bot's open plea for help, verbatim, or null when none is open. */
  helpReason: string | null;
  heldSinceMs: number | null;
}

/** Stable identity for a computer-control hold. Shared Local VM bots on the
 * same host+target share one hold; cloud, host CUA, and per-bot VMs stay
 * per-bot. Host is part of the key so a later reassignment cannot inherit
 * a hold from a different machine. */
export function computerControlResourceKey(input: {
  botId: string;
  computer?: string | null;
  targetKey: string;
  hostId: string | null;
}): string {
  if (input.computer !== "vm") return `bot:${input.botId}`;
  const host = input.hostId || "local";
  return `vm:${host}:${input.targetKey}`;
}

export interface ComputerControlOptions {
  /** Defaults to the bot id (per-bot computers). */
  resourceKeyFor?: (botId: string) => string;
  /** Bots currently sharing a resource; used to fan out hold changes. */
  botsForResource?: (resourceKey: string) => string[];
}

const NO_CONTROL: ControlSnapshot = { held: false, helpReason: null, heldSinceMs: null };
/** Keep a shouted help reason card-sized; the transcript has the rest. */
const MAX_REASON_CHARS = 280;

interface HelpEntry {
  helpReason: string;
  helpRequestId: string;
}

export class ComputerControl {
  private holds = new Map<string, number>();
  private help = new Map<string, HelpEntry>();
  private onChange: (botId: string, snapshot: ControlSnapshot) => void;
  private now: () => number;
  private resourceKeyFor: (botId: string) => string;
  private botsForResource: (resourceKey: string) => string[];
  private requestSequence = 0;

  constructor(
    onChange: (botId: string, snapshot: ControlSnapshot) => void = () => {},
    now: () => number = Date.now,
    options: ComputerControlOptions = {},
  ) {
    this.onChange = onChange;
    this.now = now;
    this.resourceKeyFor = options.resourceKeyFor ?? ((botId) => botId);
    this.botsForResource = options.botsForResource ?? (() => []);
  }

  snapshot(botId: string): ControlSnapshot {
    const heldSinceMs = this.holds.get(this.resourceKeyFor(botId)) ?? null;
    const help = this.help.get(botId);
    if (heldSinceMs === null && !help) return NO_CONTROL;
    return {
      held: heldSinceMs !== null,
      helpReason: help?.helpReason ?? null,
      heldSinceMs,
    };
  }

  /** The person takes the wheel. Idempotent — a second click must not
   * reset `heldSinceMs` and make the hold look newer than it is. */
  take(botId: string): ControlSnapshot {
    const resourceKey = this.resourceKeyFor(botId);
    if (this.holds.has(resourceKey)) return this.snapshot(botId);
    this.holds.set(resourceKey, this.now());
    return this.changed(botId, resourceKey);
  }

  /** The person hands the wheel back. Also settles any open help request —
   * the waiting bot resumes from this one state change. */
  release(botId: string): ControlSnapshot {
    const resourceKey = this.resourceKeyFor(botId);
    const hadHold = this.holds.delete(resourceKey);
    const peers = hadHold ? this.peerIds(resourceKey, botId) : [];
    const hadHelp = this.help.delete(botId);
    if (hadHold) {
      for (const peerId of peers) this.help.delete(peerId);
    }
    if (!hadHold && !hadHelp) return NO_CONTROL;
    return this.changed(botId, hadHold ? resourceKey : undefined);
  }

  /** The bot asks the person to take over. Never grants anything by
   * itself — it only surfaces the plea. A reason shouted while the person
   * is already driving is kept, but must not clobber an earlier one they
   * may still be reading. */
  requestHelp(botId: string, reason: unknown): ControlSnapshot {
    return this.requestHelpLease(botId, reason).snapshot;
  }

  /** Open a help request and return the lease that owns it. A proxy uses
   * this id to expire only its own unanswered plea when its wait ends. */
  requestHelpLease(botId: string, reason: unknown): { snapshot: ControlSnapshot; requestId: string } {
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_CHARS) : "";
    let entry = this.help.get(botId);
    if (!entry) {
      entry = {
        helpReason: text || "the bot asked you to take over",
        helpRequestId: `${botId}-${++this.requestSequence}`,
      };
      this.help.set(botId, entry);
    }
    return { snapshot: this.changed(botId), requestId: entry.helpRequestId };
  }

  /** The person declines without taking over; the waiting bot is told. */
  dismissHelp(botId: string): ControlSnapshot {
    if (!this.help.has(botId)) return this.snapshot(botId);
    this.help.delete(botId);
    return this.changed(botId);
  }

  /** Expire an unanswered plea. The id comparison prevents an old proxy's
   * timeout from dismissing a newer request for the same bot. */
  expireHelp(botId: string, requestId: unknown): ControlSnapshot {
    const entry = this.help.get(botId);
    if (!entry || entry.helpRequestId !== requestId) return this.snapshot(botId);
    this.help.delete(botId);
    return this.changed(botId);
  }

  /** The bot is gone. A shared hold stays with whatever bots still use
   * that computer; an exclusive hold dies with its last bot. */
  forget(botId: string): void {
    const resourceKey = this.resourceKeyFor(botId);
    const hadHelp = this.help.delete(botId);
    const hadHold = this.holds.has(resourceKey);
    const peers = this.peerIds(resourceKey, botId);
    if (hadHold && peers.length === 0) this.holds.delete(resourceKey);
    if (hadHelp || hadHold) this.onChange(botId, NO_CONTROL);
  }

  private peerIds(resourceKey: string, botId: string): string[] {
    return this.botsForResource(resourceKey).filter((id) => id !== botId);
  }

  private changed(botId: string, fanoutResourceKey?: string): ControlSnapshot {
    const ids = fanoutResourceKey
      ? [...new Set([botId, ...this.botsForResource(fanoutResourceKey)])]
      : [botId];
    let result = this.snapshot(botId);
    for (const id of ids) {
      const snapshot = this.snapshot(id);
      this.onChange(id, snapshot);
      if (id === botId) result = snapshot;
    }
    return result;
  }
}
