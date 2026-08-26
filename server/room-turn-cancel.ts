/** The immutable identity carried by work that belongs to one room turn. */
export interface RoomTurnIdentity {
  readonly threadId: string;
  readonly generation: number;
}

/**
 * Tracks cancellation for one serialized room turn chain. An interrupt bumps
 * the room generation, but only the currently active chain is marked
 * cancelled; a later queued message begins a fresh generation.
 */
export interface RoomTurnRun extends RoomTurnIdentity {
  cancelled: boolean;
}

export interface RoomTurnDispatchResult<T> {
  value?: T;
  cancelled: boolean;
  /** True only when the adapter dispatch resolved and registered a provider turn. */
  started: boolean;
}

export class RoomTurnCancellation {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, RoomTurnRun>();
  /** A provider can acknowledge Stop before it emits its terminal event. Keep
   * the cancelled identity around for late card callbacks during that gap. */
  private readonly terminal = new Map<string, Map<number, RoomTurnRun>>();
  /** Provider turn ids are the only stable identity on a shared room thread
   * once a later generation has started. Keep their immutable room run until
   * the matching terminal event arrives. */
  private readonly turnRuns = new Map<string, RoomTurnIdentity>();
  /** Provider turn ids whose terminal event already beat dispatch
   * resolution. A generation may legitimately host several sequential
   * provider turns (for example an @mention chain), so this is turn-scoped,
   * not generation-scoped. */
  private readonly completedTurns = new Map<string, RoomTurnIdentity>();
  private readonly completedTurnOrder: string[] = [];
  private readonly cancelHandlers = new Map<RoomTurnRun, Set<() => void>>();

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}\u0000${turnId}`;
  }

  begin(threadId: string): RoomTurnRun {
    const generation = (this.generations.get(threadId) ?? 0) + 1;
    const run: RoomTurnRun = { threadId, generation, cancelled: false };
    this.generations.set(threadId, generation);
    this.active.set(threadId, run);
    return run;
  }

  finish(threadId: string, run: RoomTurnRun): void {
    if (this.active.get(threadId) === run) this.active.delete(threadId);
    this.cancelHandlers.delete(run);
  }

  /** Keep a stopped, successfully registered provider turn scoped until its
   * terminal event arrives. The caller may finish its orchestration promise;
   * this tombstone is only for callbacks that arrive while the provider is
   * still winding down. */
  holdUntilTerminal(threadId: string, run: RoomTurnRun): boolean {
    if (!run.cancelled || run.threadId !== threadId) return false;
    const active = this.active.get(threadId);
    if (active && active !== run) return false;
    const held = this.terminal.get(threadId) ?? new Map<number, RoomTurnRun>();
    held.set(run.generation, run);
    this.terminal.set(threadId, held);
    return true;
  }

  /** Return active work, or the stopped generation awaiting its terminal
   * provider event when the orchestration promise already finished. */
  currentOrHeld(threadId: string): RoomTurnRun | null {
    const active = this.active.get(threadId);
    if (active) return active;
    const held = this.terminal.get(threadId);
    if (!held?.size) return null;
    return [...held.values()].reduce((latest, run) => (run.generation > latest.generation ? run : latest));
  }

  /** Associate a provider turn with the immutable room generation that
   * created it. This remains valid after Stop and while a later generation
   * is active on the same provider thread. */
  registerTurn(threadId: string, run: RoomTurnIdentity, turnId: string): boolean {
    if (!turnId || run.threadId !== threadId) return false;
    const active = this.active.get(threadId);
    const held = this.terminal.get(threadId)?.get(run.generation);
    const activeMatches = active?.threadId === run.threadId && active.generation === run.generation;
    if (!activeMatches && !held) return false;
    const key = this.turnKey(threadId, turnId);
    if (this.completedTurns.has(key)) return false;
    const existing = this.turnRuns.get(key);
    if (existing && existing.generation !== run.generation) return false;
    this.turnRuns.set(key, { threadId: run.threadId, generation: run.generation });
    return true;
  }

  /** Resolve a provider event's immutable room identity, if it was
   * registered. */
  runForTurn(threadId: string, turnId: string): RoomTurnIdentity | null {
    const run = this.turnRuns.get(this.turnKey(threadId, turnId));
    return run ? { threadId: run.threadId, generation: run.generation } : null;
  }

  /** Record a terminal provider event before its send promise resolves. The
   * mapping is retained only as a bounded collision guard; runForTurn stays
   * null after completion so a duplicate event cannot be mistaken for a live
   * room activity. */
  completeTurn(threadId: string, turnId: string, generation: number): boolean {
    if (!turnId) return false;
    const key = this.turnKey(threadId, turnId);
    const current = this.turnRuns.get(key);
    if (current && current.generation !== generation) return false;
    const completed = this.completedTurns.get(key);
    if (completed && completed.generation !== generation) return false;
    const active = this.active.get(threadId);
    const held = this.terminal.get(threadId)?.get(generation);
    if (!current && !completed && active?.generation !== generation && !held) return false;
    this.turnRuns.delete(key);
    if (!completed) {
      this.completedTurns.set(key, { threadId, generation });
      this.completedTurnOrder.push(key);
      while (this.completedTurnOrder.length > 256) {
        const oldest = this.completedTurnOrder.shift();
        if (oldest) this.completedTurns.delete(oldest);
      }
    }
    return true;
  }

  /** Forget one provider turn mapping after its terminal event or a failed
   * dispatch. A generation guard prevents a late cleanup from deleting a
   * mapping that has been reused for a different run. */
  forgetTurn(threadId: string, turnId: string, generation?: number): boolean {
    const key = this.turnKey(threadId, turnId);
    const run = this.turnRuns.get(key);
    if (!run || (generation !== undefined && run.generation !== generation)) return false;
    this.turnRuns.delete(key);
    return true;
  }

  /** Forget one held generation after its matching provider terminal event. */
  settle(threadId: string, generation: number): boolean {
    const held = this.terminal.get(threadId);
    const removed = Boolean(held?.delete(generation));
    if (!removed) return false;
    if (held && !held.size) this.terminal.delete(threadId);
    for (const [key, run] of this.turnRuns) {
      if (run.threadId === threadId && run.generation === generation) this.turnRuns.delete(key);
    }
    return true;
  }

  /** Return the currently active run without exposing a mutable map entry. */
  current(threadId: string): RoomTurnRun | null {
    return this.active.get(threadId) ?? null;
  }

  isActive(threadId: string, run: RoomTurnRun): boolean {
    return this.active.get(threadId) === run;
  }

  /** Subscribe to the active run's cancellation. The callback is invoked
   * synchronously by interrupt(), including when cancellation won the race
   * before this subscription was installed. */
  onCancel(threadId: string, run: RoomTurnRun, handler: () => void): () => void {
    if (!this.isActive(threadId, run) || this.isCancelled(threadId, run)) {
      handler();
      return () => {};
    }
    const handlers = this.cancelHandlers.get(run) ?? new Set<() => void>();
    handlers.add(handler);
    this.cancelHandlers.set(run, handlers);
    return () => {
      const current = this.cancelHandlers.get(run);
      if (!current) return;
      current.delete(handler);
      if (!current.size) this.cancelHandlers.delete(run);
    };
  }

  interrupt(threadId: string): boolean {
    const run = this.active.get(threadId);
    if (!run) return false;
    this.generations.set(threadId, (this.generations.get(threadId) ?? run.generation) + 1);
    run.cancelled = true;
    const handlers = this.cancelHandlers.get(run);
    this.cancelHandlers.delete(run);
    for (const handler of handlers ?? []) {
      try {
        handler();
      } catch {
        // Cancellation must not prevent the route from interrupting the
        // provider or closing the room.
      }
    }
    return true;
  }

  /** Retire all state for a deleted thread. An old callback still sees its
   * run as cancelled, while a future thread with the same room id starts at
   * a clean generation. */
  retire(threadId: string): boolean {
    const run = this.active.get(threadId);
    if (run) {
      run.cancelled = true;
      const handlers = this.cancelHandlers.get(run);
      this.cancelHandlers.delete(run);
      for (const handler of handlers ?? []) {
        try {
          handler();
        } catch {
          // Retirement is best-effort; deletion must still complete.
        }
      }
    }
    this.active.delete(threadId);
    this.terminal.delete(threadId);
    for (const key of this.completedTurnOrder) {
      if (key.startsWith(`${threadId}\u0000`)) this.completedTurns.delete(key);
    }
    for (let i = this.completedTurnOrder.length - 1; i >= 0; i -= 1) {
      if (this.completedTurnOrder[i]?.startsWith(`${threadId}\u0000`)) this.completedTurnOrder.splice(i, 1);
    }
    for (const [key, run] of this.turnRuns) {
      if (run.threadId === threadId) this.turnRuns.delete(key);
    }
    this.generations.delete(threadId);
    return Boolean(run);
  }

  isCancelled(threadId: string, run: RoomTurnIdentity): boolean {
    return (
      run.threadId !== threadId ||
      ("cancelled" in run && Boolean(run.cancelled)) ||
      this.generations.get(threadId) !== run.generation
    );
  }
}

/** Dispatch one adapter turn while watching its room generation. Adapters
 * register their active process asynchronously, so a Stop can arrive before
 * `dispatch` has made an interrupt visible. The cancellation callback fires
 * immediately, and the post-dispatch check fires once more after registration
 * has completed. The result records whether dispatch resolved (`started`) so a
 * rejected dispatch can release room ownership without waiting for an event
 * that no provider turn can emit. No adapter contract change is required. */
export async function dispatchRoomTurn<T>(
  cancellation: RoomTurnCancellation,
  run: RoomTurnRun,
  dispatch: () => Promise<T>,
  interrupt: () => Promise<void> | void,
): Promise<RoomTurnDispatchResult<T>> {
  const requestInterrupt = () => {
    try {
      void Promise.resolve(interrupt()).catch(() => {});
    } catch {
      // A provider interrupt is best-effort; cancellation must still close
      // the orchestration path.
    }
  };
  if (!cancellation.isActive(run.threadId, run) || cancellation.isCancelled(run.threadId, run)) {
    requestInterrupt();
    return { cancelled: true, started: false };
  }
  let unregister = () => {};
  unregister = cancellation.onCancel(run.threadId, run, requestInterrupt);
  if (!cancellation.isActive(run.threadId, run) || cancellation.isCancelled(run.threadId, run)) {
    unregister();
    requestInterrupt();
    return { cancelled: true, started: false };
  }
  try {
    const value = await dispatch();
    if (cancellation.isCancelled(run.threadId, run)) {
      requestInterrupt();
      return { value, cancelled: true, started: true };
    }
    return { value, cancelled: false, started: true };
  } catch (error) {
    if (cancellation.isCancelled(run.threadId, run)) {
      requestInterrupt();
      return { cancelled: true, started: false };
    }
    throw error;
  } finally {
    unregister();
  }
}
