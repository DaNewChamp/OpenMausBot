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
  private readonly cancelHandlers = new Map<RoomTurnRun, Set<() => void>>();

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
