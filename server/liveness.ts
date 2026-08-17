// Turn liveness: noticing when a running turn has gone quiet. A driver
// process that DIES is already handled — every child driver settles on
// close — but a driver that HANGS (a stalled request, an ACP prompt that
// never resolves, an SSE that never ends) leaves the bot busy until a human
// presses Stop. This is the harness's own clock over the event stream, so
// it works for every driver alike.
//
// Two thresholds. Quiet past `quietAfterMs` is surfaced (a "quiet for 3m"
// note next to Stop) — informative, not a judgement: a long silent tool
// run looks the same. Quiet past `stopAfterMs` stops the turn, but ONLY
// for turns nobody is watching (routines, webhooks): an interactive turn
// has a visible Stop and a human who can decide.

export type TurnSource = "user" | "automation";

export type LivenessAction =
  | { threadId: string; action: "flag"; quietSince: number }
  | { threadId: string; action: "clear" }
  | { threadId: string; action: "stop"; quietSince: number };

interface Tracked {
  source: TurnSource;
  lastEventAt: number;
  flagged: boolean;
  stopped: boolean;
}

export class TurnLiveness {
  private readonly turns = new Map<string, Tracked>();
  private readonly opts: { quietAfterMs: number; stopAfterMs: number };

  constructor(opts: { quietAfterMs: number; stopAfterMs: number }) {
    this.opts = opts;
  }

  /** A turn was dispatched. Restarting a thread resets its clock. */
  start(threadId: string, input: { source: TurnSource; at: number }) {
    this.turns.set(threadId, { source: input.source, lastEventAt: input.at, flagged: false, stopped: false });
  }

  /** Any runtime event for the thread counts as a sign of life. */
  touch(threadId: string, at: number) {
    const t = this.turns.get(threadId);
    if (t) t.lastEventAt = at;
  }

  /** The turn ended. Returns true when it was flagged, so the caller can
   * clear the note in the UI. */
  settle(threadId: string): boolean {
    const t = this.turns.get(threadId);
    this.turns.delete(threadId);
    return Boolean(t?.flagged);
  }

  /** When the thread went quiet, if it is currently flagged. */
  quietSince(threadId: string): number | null {
    const t = this.turns.get(threadId);
    return t?.flagged ? t.lastEventAt : null;
  }

  /** Advance the clock. Each transition is reported once. */
  tick(now: number): LivenessAction[] {
    const out: LivenessAction[] = [];
    for (const [threadId, t] of this.turns) {
      if (t.stopped) continue;
      const quiet = now - t.lastEventAt;
      if (t.flagged && quiet < this.opts.quietAfterMs) {
        t.flagged = false;
        out.push({ threadId, action: "clear" });
        continue;
      }
      if (t.source === "automation" && quiet >= this.opts.stopAfterMs) {
        t.stopped = true;
        out.push({ threadId, action: "stop", quietSince: t.lastEventAt });
        continue;
      }
      if (!t.flagged && quiet >= this.opts.quietAfterMs) {
        t.flagged = true;
        out.push({ threadId, action: "flag", quietSince: t.lastEventAt });
      }
    }
    return out;
  }
}
