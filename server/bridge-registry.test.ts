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

  it("delivers shell jobs on heartbeat", () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({ name: "worker", code, capabilities: ["shell"] });
    registry.enqueueShell(bridgeId, "echo hi");
    const bridge = registry.authorize(`Bearer ${bridgeToken}`);
    expect(bridge).toBeTruthy();
    const jobs = registry.pollJobs(bridgeId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe("shell");
    expect(jobs[0] && jobs[0].kind === "shell" ? jobs[0].command : "").toBe("echo hi");
    expect(registry.pollJobs(bridgeId)).toEqual([]);
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
    expect(jobs[0] && jobs[0].kind === "local-vm-action" ? jobs[0].payload : null).toEqual({
      botId: "bot-1",
      action: "stop",
    });
    expect(jobs[1] && jobs[1].kind === "ssh-exec" ? jobs[1].alias : "").toBe("windows");
  });
});
