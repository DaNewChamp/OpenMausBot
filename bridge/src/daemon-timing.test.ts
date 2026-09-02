import { describe, expect, it } from "vitest";

import {
  bridgeHeartbeatIntervalMs,
  bridgeHermesExecutionEnabled,
  DEFAULT_BRIDGE_HEARTBEAT_MS,
  HERMES_ACTIVE_BRIDGE_HEARTBEAT_MS,
} from "./daemon-timing.ts";
import { handleJob as handleJobForTest } from "./index-helpers.ts";
import type { BridgeJob } from "./types.ts";

describe("bridge daemon timing", () => {
  it("uses a faster heartbeat while Hermes jobs are active", () => {
    expect(bridgeHeartbeatIntervalMs(false)).toBe(DEFAULT_BRIDGE_HEARTBEAT_MS);
    expect(bridgeHeartbeatIntervalMs(true)).toBe(HERMES_ACTIVE_BRIDGE_HEARTBEAT_MS);
    expect(HERMES_ACTIVE_BRIDGE_HEARTBEAT_MS).toBeLessThan(DEFAULT_BRIDGE_HEARTBEAT_MS);
  });

  it("requires OMB_BRIDGE_HERMES=1 for local Hermes execution", async () => {
    const job = {
      id: "job-1",
      bridgeId: "bridge-1",
      kind: "hermes-discover",
      payload: {},
      timeoutMs: 30_000,
      createdAt: Date.now(),
    } satisfies BridgeJob;
    const result = await handleJobForTest(job, undefined, { OMB_BRIDGE_HERMES: "0" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/disabled locally/i);
  });
});

describe("bridgeHermesExecutionEnabled", () => {
  it("returns true only when OMB_BRIDGE_HERMES is 1", () => {
    expect(bridgeHermesExecutionEnabled({ OMB_BRIDGE_HERMES: "1" })).toBe(true);
    expect(bridgeHermesExecutionEnabled({ OMB_BRIDGE_HERMES: "0" })).toBe(false);
    expect(bridgeHermesExecutionEnabled({})).toBe(false);
  });
});
