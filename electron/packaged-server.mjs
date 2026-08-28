// Identity probe for the packaged harness server child.
//
// The desktop process waits for /api/health before loading the UI. A stray
// listener on 8799 that accepts TCP and never replies used to stall that
// wait forever — no window, no companion, main PID still alive. Bound every
// probe so a hung peer is "unreachable" and we move to the next port.

export const PACKAGED_SERVER_HEALTH_TIMEOUT_MS = 1_000;

export async function probeOwnedPackagedServer({
  port,
  pid,
  fetchImpl = fetch,
  timeoutSignal,
  timeoutMs = PACKAGED_SERVER_HEALTH_TIMEOUT_MS,
}) {
  const controller = timeoutSignal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();
  const signal = timeoutSignal ? timeoutSignal(timeoutMs) : controller.signal;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal });
    if (!response.ok) return { status: "not-ok" };
    const body = await response.json().catch(() => null);
    if (body?.app === "openmausbot" && body.pid === pid && body.static) {
      return { status: "owned", body };
    }
    return { status: "foreign", body };
  } catch {
    return { status: "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
