export interface RoomQueueGroup {
  busyBotId?: string | null;
}

export interface RoomQueueState {
  group(id: string): RoomQueueGroup | undefined;
  onChange(listener: (change: { type: string; groupId?: string }) => void): () => void;
}

const DEFAULT_RETRY_MS = 1_000;

/** Wait for a room's transient member owner to release. Store changes wake
 * the waiter immediately; the bounded timer is only a fallback for a
 * provider that failed to emit the clearing change. */
export function waitForRoomIdle(
  state: RoomQueueState,
  groupId: string,
  retryMs = DEFAULT_RETRY_MS,
): Promise<boolean> {
  const current = state.group(groupId);
  if (!current) return Promise.resolve(false);
  if (!current.busyBotId) return Promise.resolve(true);
  const delay = Math.max(50, Math.min(retryMs, 5_000));
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};
    const finish = (idle: boolean) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      resolve(idle);
    };
    const check = () => {
      const group = state.group(groupId);
      if (!group) return finish(false);
      if (!group.busyBotId) return finish(true);
      timer = setTimeout(check, delay);
      timer.unref?.();
    };
    unsubscribe = state.onChange((change) => {
      if (change.groupId !== groupId) return;
      if (change.type === "group.deleted") return finish(false);
      if (change.type === "group" && !state.group(groupId)?.busyBotId) finish(true);
    });
    check();
  });
}

/** Run one serialized room turn once its previous owner is idle. The loop
 * rechecks after every wake so a new turn that wins the race is never
 * overlapped, and a deleted room cancels without dispatching. */
export async function runWhenRoomIdle(
  state: RoomQueueState,
  groupId: string,
  run: () => void | Promise<void>,
  retryMs = DEFAULT_RETRY_MS,
): Promise<boolean> {
  for (;;) {
    const group = state.group(groupId);
    if (!group) return false;
    if (!group.busyBotId) {
      await run();
      return true;
    }
    if (!(await waitForRoomIdle(state, groupId, retryMs))) return false;
  }
}
