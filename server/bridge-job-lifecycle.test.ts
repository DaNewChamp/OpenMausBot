import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry, IdempotencyConflictError } from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";
import { runShellOnBridge } from "./bridge-exec.ts";
import { runShellJob } from "../bridge/src/exec.ts";

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
    const second = registry.enqueueShell(bridgeId, "echo one", undefined, 60_000, { idempotencyKey: "run-1" });
    expect(second.id).toBe(first.id);
    expect(registry.listJobs(bridgeId)).toHaveLength(1);
  });

  it("rejects an idempotency key reused with a different payload", () => {
    const { registry, bridgeId } = pairedShellBridge();
    registry.enqueueShell(bridgeId, "echo one", undefined, 60_000, { idempotencyKey: "run-1" });
    expect(() => registry.enqueueShell(bridgeId, "echo two", undefined, 60_000, { idempotencyKey: "run-1" })).toThrow(
      IdempotencyConflictError,
    );
    expect(registry.listJobs(bridgeId)).toHaveLength(1);
    expect(registry.listJobs(bridgeId)[0]?.job).toMatchObject({ command: "echo one" });
  });

  it("does not redeliver a running job while the bridge is online", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo retry");
    const [first] = registry.pollJobs(bridgeId);
    expect(first?.id).toBe(job.id);
    expect(first?.generation).toBe(1);
    expect(registry.getJob(job.id)?.status).toBe("running");

    vi.advanceTimersByTime(31_000);
    registry.touch(bridgeId);
    registry.reconcile(Date.now());
    expect(registry.pollJobs(bridgeId)).toEqual([]);
    expect(registry.getJob(job.id)?.attempt).toBe(1);
    expect(registry.getJob(job.id)?.generation).toBe(1);
    vi.useRealTimers();
  });

  it("redelivers a stale running job only after the bridge is offline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo retry");
    registry.pollJobs(bridgeId);

    vi.advanceTimersByTime(31_000);
    registry.reconcile(Date.now());
    const redelivered = registry.pollJobs(bridgeId);
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0]?.id).toBe(job.id);
    expect(redelivered[0]?.generation).toBe(2);
    expect(registry.getJob(job.id)?.attempt).toBe(2);
    vi.useRealTimers();
  });

  it("rejects a stale-generation result after redelivery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo fence");
    const [first] = registry.pollJobs(bridgeId);
    vi.advanceTimersByTime(31_000);
    registry.reconcile(Date.now());
    const [second] = registry.pollJobs(bridgeId);
    expect(second?.generation).toBe(2);
    expect(
      registry.storeResult({
        jobId: job.id,
        bridgeId,
        exitCode: 0,
        stdout: "old\n",
        stderr: "",
        truncated: false,
        finishedAt: Date.now(),
        generation: first?.generation,
      }),
    ).toBe(false);
    expect(registry.getJob(job.id)?.status).toBe("running");
    expect(
      registry.storeResult({
        jobId: job.id,
        bridgeId,
        exitCode: 0,
        stdout: "new\n",
        stderr: "",
        truncated: false,
        finishedAt: Date.now(),
        generation: second?.generation,
      }),
    ).toBe(true);
    expect(registry.result(job.id)?.stdout).toBe("new\n");
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

  it("cancels queued jobs immediately and marks running jobs cancelRequested", async () => {
    vi.useFakeTimers();
    try {
      const { registry, bridgeId } = pairedShellBridge();
      const queued = registry.enqueueShell(bridgeId, "echo queued");
      expect(registry.cancelJob(queued.id)?.status).toBe("cancelled");

      const running = registry.enqueueShell(bridgeId, "echo running");
      const [delivered] = registry.pollJobs(bridgeId);
      const cancelled = registry.cancelJob(running.id);
      expect(cancelled?.status).toBe("running");
      expect(cancelled?.cancelRequestedAt).toBeTruthy();
      expect(registry.pollJobs(bridgeId)).toEqual([]);
      expect(registry.cancelRequests(bridgeId)).toEqual([running.id]);

      const waitPromise = waitForBridgeJobResult(registry, running.id, 5_000, "mini");
      registry.storeResult({
        jobId: running.id,
        bridgeId,
        exitCode: 143,
        stdout: "",
        stderr: "cancelled",
        truncated: false,
        finishedAt: Date.now(),
        generation: delivered?.generation,
      });
      const rejection = expect(waitPromise).rejects.toThrow(/cancelled/);
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(registry.getJob(running.id)?.status).toBe("cancelled");
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
        generation: job!.generation,
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

  it("returns nonzero exit results instead of throwing", async () => {
    vi.useFakeTimers();
    try {
      const { registry, bridgeId } = pairedShellBridge();
      const runPromise = runShellOnBridge(registry, { name: "mini", command: "false", timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(500);
      const [job] = registry.pollJobs(bridgeId);
      registry.storeResult({
        jobId: job!.id,
        bridgeId,
        exitCode: 1,
        stdout: "kept-stdout",
        stderr: "kept-stderr",
        truncated: false,
        finishedAt: Date.now(),
        generation: job!.generation,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(runPromise).resolves.toMatchObject({
        exitCode: 1,
        stdout: "kept-stdout",
        stderr: "kept-stderr",
        bridgeName: "mini",
      });
      expect(registry.getJob(job!.id)?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores duplicate result delivery", () => {
    const { registry, bridgeId } = pairedShellBridge();
    const job = registry.enqueueShell(bridgeId, "echo once");
    const [delivered] = registry.pollJobs(bridgeId);
    const result = {
      jobId: job.id,
      bridgeId,
      exitCode: 0,
      stdout: "once\n",
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: delivered?.generation,
    };
    expect(registry.storeResult(result)).toBe(true);
    expect(registry.storeResult({ ...result, stdout: "mutated\n" })).toBe(false);
    expect(registry.result(job.id)?.stdout).toBe("once\n");
  });

  it("rejects unknown and foreign results without ghost-creating records", () => {
    const { registry, bridgeId } = pairedShellBridge();
    const { code } = registry.startPairing();
    const other = registry.register({ name: "other", code, capabilities: ["shell"] });
    const job = registry.enqueueShell(bridgeId, "echo victim");
    const [delivered] = registry.pollJobs(bridgeId);

    expect(
      registry.storeResult({
        jobId: "ghost-id-not-enqueued",
        bridgeId,
        exitCode: 0,
        stdout: "injected",
        stderr: "",
        truncated: false,
        finishedAt: Date.now(),
        generation: 1,
      }),
    ).toBe(false);
    expect(registry.getJob("ghost-id-not-enqueued")).toBeNull();

    expect(
      registry.storeResult({
        jobId: job.id,
        bridgeId: other.bridgeId,
        exitCode: 0,
        stdout: "hijacked",
        stderr: "",
        truncated: false,
        finishedAt: Date.now(),
        generation: delivered?.generation,
      }),
    ).toBe(false);
    expect(registry.getJob(job.id)?.status).toBe("running");
    expect(registry.result(job.id)).toBeNull();
  });

  it("interrupts a shell job when the abort signal fires", async () => {
    const abort = new AbortController();
    const run = runShellJob(
      {
        id: "job-abort",
        bridgeId: "bridge-abort",
        kind: "shell",
        command: "sleep 30",
        timeoutMs: 60_000,
        createdAt: Date.now(),
      },
      abort.signal,
    );
    abort.abort();
    const result = await run;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/cancel/i);
  });
});
