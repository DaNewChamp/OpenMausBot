import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { runLocalVmOnBridge } from "./bridge-local-vm.ts";

describe("bridge local-vm relay", () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });

  it("runs local-vm status job and parses JSON payload", async () => {
    vi.useFakeTimers();
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({
      name: "mini",
      code,
      capabilities: ["shell", "local-vm"],
    });
    registry.touch(bridgeId);
    expect(registry.authorize(`Bearer ${bridgeToken}`)).toBeTruthy();

    const runPromise = runLocalVmOnBridge(registry, { name: "mini", botId: "bot-a", op: "status" });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("local-vm-status");
    expect(job?.kind === "local-vm-status" ? job.payload.botId : "").toBe("bot-a");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: JSON.stringify({ container: "running", ready: true }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(runPromise).resolves.toMatchObject({
      bridgeName: "mini",
      data: { container: "running", ready: true },
    });
    vi.useRealTimers();
  });

  it("pins local-vm jobs to the assigned bridge id", async () => {
    vi.useFakeTimers();
    const registry = new BridgeRegistry();
    const first = registry.startPairing();
    const mini = registry.register({ name: "mini", code: first.code, capabilities: ["shell", "local-vm"] });
    registry.touch(mini.bridgeId);
    const second = registry.startPairing();
    const other = registry.register({ name: "other", code: second.code, capabilities: ["shell", "local-vm"] });
    registry.touch(other.bridgeId);

    const runPromise = runLocalVmOnBridge(registry, {
      bridgeId: mini.bridgeId,
      botId: "bot-a",
      op: "status",
    });
    await vi.advanceTimersByTimeAsync(500);
    const miniJobs = registry.pollJobs(mini.bridgeId);
    const otherJobs = registry.pollJobs(other.bridgeId);
    expect(otherJobs).toEqual([]);
    expect(miniJobs[0]?.kind).toBe("local-vm-status");
    registry.storeResult({
      jobId: miniJobs[0]!.id,
      bridgeId: mini.bridgeId,
      exitCode: 0,
      stdout: JSON.stringify({ container: "running", ready: true }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: miniJobs[0]!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(runPromise).resolves.toMatchObject({ bridgeName: "mini" });
    vi.useRealTimers();
  });

  it("rejects local-vm jobs when capability is missing", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "shell-only", code, capabilities: ["shell"] });
    expect(() => registry.enqueueLocalVmJob(bridgeId, "local-vm-status", { botId: "bot-a" })).toThrow(
      /local-vm capability/,
    );
  });
});
