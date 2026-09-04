import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { cancelLocalVmInvokeJobs, runLocalVmOnBridge, shouldRelayLocalVm } from "./bridge-local-vm.ts";

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

  it("maps action and screenshot ops onto the matching bridge job kinds", async () => {
    vi.useFakeTimers();
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({
      name: "windows",
      code,
      capabilities: ["shell", "local-vm"],
    });
    registry.touch(bridgeId);

    const runPromise = runLocalVmOnBridge(registry, {
      bridgeId,
      botId: "shared",
      op: "action",
      action: "run",
    });
    await vi.advanceTimersByTimeAsync(500);
    const [actionJob] = registry.pollJobs(bridgeId);
    expect(actionJob?.kind).toBe("local-vm-action");
    expect(actionJob?.kind === "local-vm-action" ? actionJob.payload : null).toMatchObject({
      botId: "shared",
      action: "run",
    });
    registry.storeResult({
      jobId: actionJob!.id,
      bridgeId,
      exitCode: 0,
      stdout: JSON.stringify({ container: "running", ready: true }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: actionJob!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(runPromise).resolves.toMatchObject({
      bridgeName: "windows",
      data: { container: "running", ready: true },
    });

    const shotPromise = runLocalVmOnBridge(registry, {
      bridgeId,
      botId: "shared",
      op: "screenshot",
    });
    await vi.advanceTimersByTimeAsync(500);
    const [shotJob] = registry.pollJobs(bridgeId);
    expect(shotJob?.kind).toBe("local-vm-screenshot");
    expect(shotJob?.kind === "local-vm-screenshot" ? shotJob.payload.botId : "").toBe("shared");
    registry.storeResult({
      jobId: shotJob!.id,
      bridgeId,
      exitCode: 0,
      stdout: JSON.stringify({ image: "data:image/jpeg;base64,abc" }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: shotJob!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(shotPromise).resolves.toMatchObject({
      data: { image: "data:image/jpeg;base64,abc" },
    });
    vi.useRealTimers();
  });

  it("maps native invoke onto a typed local-vm-invoke job on the pinned bridge", async () => {
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
      botId: "shared",
      op: "invoke",
      threadId: "thread-owner",
      tool: "open_url",
      arguments: { url: "https://example.com/relay" },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(registry.pollJobs(other.bridgeId)).toEqual([]);
    const [job] = registry.pollJobs(mini.bridgeId);
    expect(job?.kind).toBe("local-vm-invoke");
    expect(job && job.kind === "local-vm-invoke" ? job.payload : null).toMatchObject({
      botId: "shared",
      threadId: "thread-owner",
      tool: "open_url",
      arguments: { url: "https://example.com/relay" },
    });
    registry.storeResult({
      jobId: job!.id,
      bridgeId: mini.bridgeId,
      exitCode: 0,
      stdout: JSON.stringify({
        text: "Opened https://example.com/relay in this bot's browser.",
        isError: false,
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(runPromise).resolves.toMatchObject({
      bridgeName: "mini",
      data: { text: "Opened https://example.com/relay in this bot's browser.", isError: false },
    });
    vi.useRealTimers();
  });

  it("relays a pinned host even when the hub has a container runtime", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "mini", code, capabilities: ["shell", "local-vm"] });
    registry.touch(bridgeId);
    const previous = process.env.OMB_LOCAL_VM_RELAY;
    delete process.env.OMB_LOCAL_VM_RELAY;
    try {
      expect(await shouldRelayLocalVm(registry, bridgeId)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OMB_LOCAL_VM_RELAY;
      else process.env.OMB_LOCAL_VM_RELAY = previous;
    }
  });

  it("fails closed on a pinned offline host and does not enqueue on another bridge", async () => {
    const registry = new BridgeRegistry();
    const first = registry.startPairing();
    const mini = registry.register({ name: "mini", code: first.code, capabilities: ["shell", "local-vm"] });
    const second = registry.startPairing();
    const other = registry.register({ name: "other", code: second.code, capabilities: ["shell", "local-vm"] });
    registry.touch(other.bridgeId);
    const storePath = join(DATA_DIR, "bridges.json");
    const store = JSON.parse(readFileSync(storePath, "utf8")) as { bridges: Array<{ id: string; lastSeenAt: number }> };
    const miniRow = store.bridges.find((entry) => entry.id === mini.bridgeId);
    expect(miniRow).toBeTruthy();
    miniRow!.lastSeenAt = 1;
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);

    await expect(
      runLocalVmOnBridge(registry, {
        bridgeId: mini.bridgeId,
        botId: "shared",
        op: "invoke",
        tool: "open_url",
        arguments: { url: "https://example.com/offline" },
      }),
    ).rejects.toThrow(/offline/);
    expect(registry.pollJobs(mini.bridgeId)).toEqual([]);
    expect(registry.pollJobs(other.bridgeId)).toEqual([]);
  });

  it("cancels queued native invoke jobs for a thread without claiming remote kill", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "mini", code, capabilities: ["shell", "local-vm"] });
    registry.touch(bridgeId);
    const queued = registry.enqueueLocalVmJob(bridgeId, "local-vm-invoke", {
      botId: "shared",
      threadId: "thread-a",
      tool: "open_url",
      arguments: { url: "https://example.com" },
    });
    const other = registry.enqueueLocalVmJob(bridgeId, "local-vm-invoke", {
      botId: "shared",
      threadId: "thread-b",
      tool: "click",
      arguments: { x: 1, y: 1 },
    });
    const cancelled = cancelLocalVmInvokeJobs(registry, (payload) => payload.threadId === "thread-a");
    expect(cancelled).toEqual([queued.id]);
    expect(registry.getJob(queued.id)?.status).toBe("cancelled");
    expect(registry.getJob(other.id)?.status).toBe("queued");
    expect(registry.getJob(queued.id)?.error).toBe("cancelled");
  });
});
