export const DEFAULT_BRIDGE_HEARTBEAT_MS = 5_000;
export const HERMES_ACTIVE_BRIDGE_HEARTBEAT_MS = 500;

export function bridgeHeartbeatIntervalMs(hermesActive: boolean): number {
  return hermesActive ? HERMES_ACTIVE_BRIDGE_HEARTBEAT_MS : DEFAULT_BRIDGE_HEARTBEAT_MS;
}

export function bridgeHermesExecutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_BRIDGE_HERMES === "1";
}
