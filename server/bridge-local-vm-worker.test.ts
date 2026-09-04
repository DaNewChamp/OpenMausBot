import { describe, expect, it } from "vitest";

import { perBotLocalVmTarget, runLocalVmJob, type CommandRunner } from "../bridge/src/local-vm.ts";
import type { LocalVmBridgeJob } from "../bridge/src/types.ts";

const image = "localhost/openmausbot/browser-vm:v1";
const guestWorkspace = "/home/cua/workspace";

const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.alloc(600),
  Buffer.from([0xff, 0xd9]),
]);

function job(action: "run" | "recreate"): LocalVmBridgeJob {
  return {
    id: `job-${action}`,
    bridgeId: "bridge",
    timeoutMs: 120_000,
    createdAt: Date.now(),
    kind: "local-vm-action",
    payload: { botId: "bot-test", action },
  };
}

function preparedImage() {
  return JSON.stringify([{
    Id: "sha256:managed-image-id",
    Config: {
      Labels: {
        "com.openmausbot.local-vm": "1",
        "com.openmausbot.computer-kind": "browser",
        "com.openmausbot.image-layer": "1",
      },
    },
  }]);
}

function runningContainer(target: ReturnType<typeof perBotLocalVmTarget>) {
  return JSON.stringify([{
    Config: {
      Image: image,
      Labels: {
        "com.openmausbot.local-vm": "1",
        "com.openmausbot.computer-kind": "browser",
        "com.openmausbot.image-layer": "1",
        "com.openmausbot.workspace": "1",
        "com.openmausbot.local-vm-target": target.label,
      },
    },
    HostConfig: {
      Memory: 1 * 1024 * 1024 * 1024,
      MemorySwap: 1 * 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 256,
      CapDrop: ["ALL"],
      CapAdd: ["CAP_SETUID", "CAP_SETGID"],
      Privileged: false,
      IpcMode: "private",
      CgroupnsMode: "private",
      ShmSize: 256 * 1024 * 1024,
      RestartPolicy: { Name: "no" },
      PortBindings: { "9222/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    },
    NetworkSettings: {
      Ports: { "9222/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    },
    Mounts: [{ Type: "bind", Source: target.workspaceDir, Destination: guestWorkspace, RW: true }],
    State: { Running: true },
    Image: "sha256:managed-image-id",
  }]);
}

function fakeRuntime(initiallyCreated: boolean) {
  const target = perBotLocalVmTarget("bot-test");
  let created = initiallyCreated;
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (command === "docker" && args[0] === "info") return { stdout: "29\n" };
    if (command === "docker" && args[0] === "image") return { stdout: preparedImage() };
    if (command === "docker" && args[0] === "inspect" && args[1] === target.containerName) {
      if (!created) throw new Error("No such container");
      return { stdout: runningContainer(target) };
    }
    if (command === "docker" && args[0] === "run") {
      created = true;
      return { stdout: "container-id\n" };
    }
    if (command === "docker" && args[0] === "rm") {
      created = false;
      return { stdout: "container-id\n" };
    }
    if (command === "docker" && args[0] === "stop") return { stdout: target.containerName };
    if (command === "docker" && args[0] === "exec" && args.some((arg) => String(arg).includes("json/version"))) {
      return { stdout: '{"Browser":"Chrome"}\n' };
    }
    if (command === "docker" && args[0] === "exec" && args.some((arg) => String(arg).includes("openmausbot-cdp.mjs"))) {
      return { stdout: '{"ok":true}\n' };
    }
    if (command === "docker" && args[0] === "exec" && args.includes("base64")) {
      return { stdout: jpeg.toString("base64") };
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

describe("bridge Local VM lifecycle", () => {
  it("creates a missing per-bot VM with the browser image and reports Chromium readiness", async () => {
    const fake = fakeRuntime(false);
    const result = await runLocalVmJob(job("run"), fake.run);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ container: "running", ready: true, desktopReady: true });
    const runCall = fake.calls.find((call) => call.startsWith("docker run ")) ?? "";
    expect(runCall).toContain(image);
    expect(runCall).toContain("--memory 1g");
    expect(runCall).toContain("--memory-swap 1g");
    expect(runCall).toContain("--cpus 1");
    expect(runCall).toContain("--pids-limit 256");
    expect(runCall).toContain("--ipc private");
    expect(runCall).toContain("--cgroupns private");
    expect(runCall).toContain("--cap-drop ALL");
    expect(runCall).toContain("--cap-add SETUID");
    expect(runCall).toContain("--cap-add SETGID");
    expect(runCall).toContain(`--mount type=bind,source=${perBotLocalVmTarget("bot-test").workspaceDir}`);
    expect(runCall).toContain(`target=${guestWorkspace}`);
    expect(runCall).toContain("-p 127.0.0.1::9222");
    expect(runCall).toContain("com.openmausbot.local-vm-target=");
  });

  it("recreate removes the old VM before creating a fresh managed one", async () => {
    const fake = fakeRuntime(true);
    const result = await runLocalVmJob(job("recreate"), fake.run);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ container: "running", ready: true });
    const removeIndex = fake.calls.findIndex((call) => call === `docker rm -f ${perBotLocalVmTarget("bot-test").containerName}`);
    const runIndex = fake.calls.findIndex((call) => call.startsWith("docker run "));
    expect(removeIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(removeIndex);
  });
});
