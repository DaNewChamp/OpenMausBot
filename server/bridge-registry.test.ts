import { mkdirSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";

describe("BridgeRegistry", () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });
  it("pairs, registers, and authorizes a bridge", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({
      name: "pi-bridge",
      code,
      capabilities: ["shell"],
    });
    expect(bridgeId).toBeTruthy();
    expect(bridgeToken).toHaveLength(48);
    const bridge = registry.authorize(`Bearer ${bridgeToken}`);
    expect(bridge?.id).toBe(bridgeId);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: bridgeId, name: "pi-bridge", capabilities: ["shell"] }),
    ]);
  });

  it("delivers shell jobs on heartbeat", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({ name: "worker", code, capabilities: ["shell"] });
    registry.enqueueShell(bridgeId, "echo hi");
    const bridge = registry.authorize(`Bearer ${bridgeToken}`);
    expect(bridge).toBeTruthy();
    const jobs = registry.pollJobs(bridgeId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.command).toBe("echo hi");
    expect(registry.pollJobs(bridgeId)).toEqual([]);
  });
});
