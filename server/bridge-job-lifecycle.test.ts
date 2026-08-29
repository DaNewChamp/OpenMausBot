import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";
import { runShellOnBridge } from "./bridge-exec.ts";

function resetBridgeData(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const file of ["bridges.json", "bridge-jobs.json"]) {
    const path = join(DATA_DIR, file);
    if (existsSync(path)) rmSync(path);
  }
}

function pairedShellBridge() {
  const registry = new BridgeRegistry();
  const { code } = registry.startPairing();
  const { bridgeId, bridgeToken } = registry.register({ name: "mini", code, capabilities: ["shell"] });
  registry.touch(bridgeId);
  return { registry, bridgeId, bridgeToken };
}

describe("bridge job lifecycle", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("deduplicates enqueue by idempotency key while job is active", () => {
    const { registry, bridgeId } = pairedShellBridge();
    const first = registry.enqueueShell(bridgeId, "echo one", undefined, 60_000, { idempotencyKey: "run-1" });
    const second = registry.enqueueShell(bridgeId, "echo two", undefined, 60_000, { idempotencyKey: "run-1" });
    expect(second.id).toBe(first.id);
    expect(registry.listJobs(bridgeId)).toHaveLength(1);
  });

  it("redelivers a stale running job after bridge reconnect", () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo retry");
    const [first] = registry.pollJobs(bridgeId);
    expect(first?.id).toBe(job.id);
    expect(registry.getJob(job.id)?.status).toBe("running");

    vi.advanceTimersByTime(31_000);
    registry.reconcile(Date.now());
    const redelivered = registry.pollJobs(bridgeId);
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.id).toBe(job.id);
    expect(registry.getJob(job.id)?.attempt).toBe(2);
    vi.useRealTimers();
  });

  it("fails queued jobs when bridge stays offline before pickup", () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo offline");
    const store = registry.list().find((b) => b.id === bridgeId);
    expect(store).toBeTruthy();

    vi.advanceTimersByTime(31 * 60_000);
    registry.reconcile(Date.now());
    expect(registry.getJob(job.id)?.status).toBe("failed");
    expect(registry.getJob(job.id)?.error).toMatch(/expired|offline|timed out/);
    vi.useRealTimers();
  });

  it("requeues running jobs when bridge drops mid-job and exhausts retries", () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo mid", undefined, 5_000, { maxAttempts: 2 });
    registry.pollJobs(bridgeId);

    for (let i = 0; i < 3; i += 1) {
      vi.advanceTimersByTime(31_000);
      registry.reconcile(Date.now());
      registry.pollJobs(bridgeId);
    }

    const record = registry.getJob(job.id);
    expect(record?.status).toBe("failed");
    expect(record?.error).toMatch(/retry attempts exhausted|offline/);
    vi.useRealTimers();
  });

  it("cancels queued and running jobs", async () => {
    vi.useFakeTimers();
    try {
      const { registry, bridgeId } = pairedShellBridge();
      const queued = registry.enqueueShell(bridgeId, "echo queued");
      expect(registry.cancelJob(queued.id)?.status).toBe("cancelled");

      const running = registry.enqueueShell(bridgeId, "echo running");
      registry.pollJobs(bridgeId);
      expect(registry.cancelJob(running.id)?.status).toBe("cancelled");

      const waitPromise = waitForBridgeJobResult(registry, running.id, 5_000, "mini");
      const rejection = expect(waitPromise).rejects.toThrow(/cancelled/);
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives harness restart via bridge-jobs.json persistence", () => {
    resetBridgeData();
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo durable");
    registry.pollJobs(bridgeId);

    const reloaded = new BridgeRegistry();
    expect(reloaded.getJob(job.id)?.status).toBe("running");
    expect(reloaded.pollJobs(bridgeId)).toEqual([]);
  });

  it("preserves truncated flag through lifecycle completion", async () => {
    vi.useFakeTimers();
    try {
      const { registry, bridgeId } = pairedShellBridge();
      const runPromise = runShellOnBridge(registry, { name: "mini", command: "printf x", timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(500);
      const [job] = registry.pollJobs(bridgeId);
      expect(job).toBeTruthy();

      registry.storeResult({
        jobId: job!.id,
        bridgeId,
        exitCode: 0,
        stdout: "x".repeat(1024 * 1024),
        stderr: "",
        truncated: true,
        finishedAt: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(runPromise).resolves.toMatchObject({
        truncated: true,
        bridgeName: "mini",
      });
      expect(registry.getJob(job!.id)?.status).toBe("succeeded");
      expect(registry.getJob(job!.id)?.result?.truncated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores duplicate result delivery", () => {
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo once");
    registry.pollJobs(bridgeId);
    const result = {
      jobId: job.id,
      bridgeId,
      exitCode: 0,
      stdout: "once\n",
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
    };
    expect(registry.storeResult(result)).toBe(true);
    expect(registry.storeResult({ ...result, stdout: "mutated\n" })).toBe(false);
    expect(registry.result(job.id)?.stdout).toBe("once\n");
  });
});
