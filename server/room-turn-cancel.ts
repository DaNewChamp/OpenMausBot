/**
 * Tracks cancellation for one serialized room turn chain. An interrupt bumps
 * the room generation, but only the currently active chain is marked
 * cancelled; a later queued message begins a fresh generation.
 */
export interface RoomTurnRun {
  readonly generation: number;
  cancelled: boolean;
}

export class RoomTurnCancellation {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, RoomTurnRun>();

  begin(groupId: string): RoomTurnRun {
    const generation = (this.generations.get(groupId) ?? 0) + 1;
    const run: RoomTurnRun = { generation, cancelled: false };
    this.generations.set(groupId, generation);
    this.active.set(groupId, run);
    return run;
  }

  finish(groupId: string, run: RoomTurnRun): void {
    if (this.active.get(groupId) === run) this.active.delete(groupId);
  }

  interrupt(groupId: string): boolean {
    const run = this.active.get(groupId);
    this.generations.set(groupId, (this.generations.get(groupId) ?? run?.generation ?? 0) + 1);
    if (!run) return false;
    run.cancelled = true;
    return true;
  }

  isCancelled(groupId: string, run: RoomTurnRun): boolean {
    return run.cancelled || this.generations.get(groupId) !== run.generation;
  }
}
