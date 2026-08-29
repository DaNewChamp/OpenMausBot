import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { resolveBridge, runShellOnBridge, runSshOnBridge } from "./bridge-exec.ts";
import { runShellJob } from "../bridge/src/exec.ts";

describe("bridge exec", () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });

  it("resolves bridge by name when online", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "Mac mini", code, capabilities: ["shell"] });
    registry.touch(bridgeId, { hostInfo: "mini" });
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
    expect(job).toMatchObject({ kind: "shell", command: "echo hi" });
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
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

  it("runs ssh job through ssh-forward bridge", async () => {
    vi.useFakeTimers();
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({
      name: "mini",
      code,
      capabilities: ["shell", "ssh-forward"],
    });
    registry.touch(bridgeId);

    const runPromise = runSshOnBridge(registry, {
      name: "mini",
      alias: "windows",
      command: "hostname",
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("ssh-exec");
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: "windows\n",
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(runPromise).resolves.toMatchObject({
      exitCode: 0,
      stdout: "windows\n",
      bridgeName: "mini",
    });
    vi.useRealTimers();
  });

  it("flags shell output truncated at the 1 MB maxBuffer", async () => {
    const result = await runShellJob({
      id: "job-truncate",
      bridgeId: "bridge-truncate",
      kind: "shell",
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(1024 * 1024 + 1))"`,
      timeoutMs: 5_000,
      createdAt: Date.now(),
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1024 * 1024);
  });
});
