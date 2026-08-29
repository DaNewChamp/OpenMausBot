import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { resolveBridge, runShellOnBridge } from "./bridge-exec.ts";

describe("bridge exec", () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });

  it("resolves bridge by name when online", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "Mac mini", code, capabilities: ["shell"] });
    registry.touch(bridgeId, "mini");
    expect(resolveBridge(registry, { name: "Mac mini" })?.id).toBe(bridgeId);
  });

  it("runs shell job and waits for bridge result", async () => {
    vi.useFakeTimers();
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({ name: "worker", code, capabilities: ["shell"] });
    registry.touch(bridgeId);
    const bridge = registry.authorize(`Bearer ${bridgeToken}`);
    expect(bridge).toBeTruthy();

    const runPromise = runShellOnBridge(registry, { name: "worker", command: "echo hi", timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.command).toBe("echo hi");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      finishedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(runPromise).resolves.toMatchObject({
      exitCode: 0,
      stdout: "hi\n",
      bridgeName: "worker",
    });
    vi.useRealTimers();
  });
});
