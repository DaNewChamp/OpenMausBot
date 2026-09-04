import { mkdirSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { asCapabilities } from "./bridge-routes.ts";

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

  it("defaults an omitted capability list to none", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "locked", code });
    expect(registry.list().find((bridge) => bridge.id === bridgeId)).toEqual(
      expect.objectContaining({ id: bridgeId, capabilities: [] }),
    );
  });

  it("normalizes omitted and unknown route capabilities to none", () => {
    expect(asCapabilities(undefined)).toEqual([]);
    expect(asCapabilities(["unknown", "shell"])).toEqual(["shell"]);
  });

  it("allows a heartbeat to clear previously advertised capabilities", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "revocable", code, capabilities: ["shell"] });
    registry.touch(bridgeId, { capabilities: [] });
    expect(registry.list().find((bridge) => bridge.id === bridgeId)?.capabilities).toEqual([]);
  });

  it("does not let a heartbeat add capabilities beyond the paired grant", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "locked", code, capabilities: [] });
    registry.touch(bridgeId, { capabilities: ["shell", "local-vm"] });
    const listed = registry.list().find((bridge) => bridge.id === bridgeId);
    expect(listed?.capabilities).toEqual([]);
    expect(listed?.grantedCapabilities).toEqual([]);
  });

  it("revokes a bridge and cancel-requests its in-flight jobs", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "gone", code, capabilities: ["shell"] });
    const running = registry.enqueueShell(bridgeId, "echo running");
    registry.pollJobs(bridgeId);
    const queued = registry.enqueueShell(bridgeId, "echo queued");
    expect(registry.revoke(bridgeId)).toBe(true);
    expect(registry.list().find((bridge) => bridge.id === bridgeId)).toBeUndefined();
    expect(registry.getJob(queued.id)?.status).toBe("cancelled");
    expect(registry.getJob(running.id)?.cancelRequestedAt).toBeTruthy();
    expect(registry.getJob(running.id)?.status).toBe("running");
  });

  it("delivers shell jobs on heartbeat and keeps durable status until result", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({ name: "worker", code, capabilities: ["shell"] });
    const job = registry.enqueueShell(bridgeId, "echo hi");
    const bridge = registry.authorize(`Bearer ${bridgeToken}`);
    expect(bridge).toBeTruthy();
    const jobs = registry.pollJobs(bridgeId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("shell");
    expect(jobs[0] && jobs[0].kind === "shell" ? jobs[0].command : "").toBe("echo hi");
    expect(registry.getJob(job.id)?.status).toBe("running");
    expect(registry.pollJobs(bridgeId)).toEqual([]);
    registry.storeResult({
      jobId: job.id,
      bridgeId,
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: jobs[0]?.generation,
    });
    expect(registry.getJob(job.id)?.status).toBe("succeeded");
  });

  it("delivers local-vm and ssh jobs when capabilities are present", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({
      name: "worker",
      code,
      capabilities: ["shell", "local-vm", "ssh-forward"],
    });
    registry.enqueueLocalVmJob(bridgeId, "local-vm-action", { botId: "bot-1", action: "stop" });
    registry.enqueueSshExec(bridgeId, "windows", "hostname");
    const jobs = registry.pollJobs(bridgeId);
    expect(jobs.map((job) => job.kind)).toEqual(["local-vm-action", "ssh-exec"]);
    expect(registry.pollJobs(bridgeId)).toEqual([]);
    expect(jobs[0] && jobs[0].kind === "local-vm-action" ? jobs[0].payload : null).toEqual({
      botId: "bot-1",
      action: "stop",
    });
    expect(jobs[1] && jobs[1].kind === "ssh-exec" ? jobs[1].alias : "").toBe("windows");
  });

  it("enqueues typed local-vm-invoke jobs and fingerprints the tool call", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({
      name: "worker",
      code,
      capabilities: ["shell", "local-vm"],
    });
    const job = registry.enqueueLocalVmJob(bridgeId, "local-vm-invoke", {
      botId: "shared",
      threadId: "thread-1",
      tool: "computer_exec",
      arguments: { command: "id" },
    });
    expect(job.kind).toBe("local-vm-invoke");
    const [delivered] = registry.pollJobs(bridgeId);
    expect(delivered?.kind).toBe("local-vm-invoke");
    expect(delivered && delivered.kind === "local-vm-invoke" ? delivered.payload : null).toEqual({
      botId: "shared",
      threadId: "thread-1",
      tool: "computer_exec",
      arguments: { command: "id" },
    });
  });
});
