import { describe, expect, it } from "vitest";

import { perBotLocalVmTarget, runLocalVmJob, type CommandRunner } from "../bridge/src/local-vm.ts";
import type { LocalVmBridgeJob } from "../bridge/src/types.ts";

const image = "localhost/openmausbot/cua-local-vm:driver-0.20.0-v5";
const baseDigest = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
const guestWorkspace = "/home/cua/workspace";
const driver = "/usr/local/libexec/openmausbot/cua-driver";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
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
        "com.openmausbot.cua-driver": "0.20.0",
        "com.openmausbot.cua-base": baseDigest,
        "com.openmausbot.image-layer": "5",
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
        "com.openmausbot.cua-driver": "0.20.0",
        "com.openmausbot.cua-base": baseDigest,
        "com.openmausbot.image-layer": "5",
        "com.openmausbot.workspace": "1",
        "com.openmausbot.local-vm-target": target.label,
      },
    },
    HostConfig: {
      Memory: 4 * 1024 * 1024 * 1024,
      MemorySwap: 4 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      CapDrop: ["ALL"],
      CapAdd: ["CAP_SETUID", "CAP_SETGID"],
      Privileged: false,
      IpcMode: "private",
      CgroupnsMode: "private",
      ShmSize: 512 * 1024 * 1024,
      RestartPolicy: { Name: "no" },
      PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    },
    NetworkSettings: {
      Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
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
    if (command === "docker" && args[0] === "exec" && args.includes(driver) && args.includes("--version")) {
      return { stdout: "cua-driver 0.20.0\n" };
    }
    if (command === "docker" && args[0] === "exec" && args.includes(driver) && args.includes("status")) {
      return { stdout: "running\n" };
    }
    if (command === "docker" && args[0] === "exec" && args.includes("health_report")) {
      return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }) };
    }
    if (command === "docker" && args[0] === "exec" && args.includes("get_desktop_state")) return { stdout: "{}\n" };
    if (command === "docker" && args[0] === "exec" && args.includes("base64")) {
      return { stdout: png.toString("base64") };
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

describe("bridge Local VM lifecycle", () => {
  it("creates a missing per-bot VM with the managed image and reports Cua readiness", async () => {
    const fake = fakeRuntime(false);
    const result = await runLocalVmJob(job("run"), fake.run);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ container: "running", ready: true, desktopReady: true });
    const runCall = fake.calls.find((call) => call.startsWith("docker run ")) ?? "";
    expect(runCall).toContain(image);
    expect(runCall).toContain("--memory 4g");
    expect(runCall).toContain("--memory-swap 4g");
    expect(runCall).toContain("--cpus 2");
    expect(runCall).toContain("--pids-limit 512");
    expect(runCall).toContain("--ipc private");
    expect(runCall).toContain("--cgroupns private");
    expect(runCall).toContain("--cap-drop ALL");
    expect(runCall).toContain("--cap-add SETUID");
    expect(runCall).toContain("--cap-add SETGID");
    expect(runCall).toContain(`--mount type=bind,source=${perBotLocalVmTarget("bot-test").workspaceDir}`);
    expect(runCall).toContain(`target=${guestWorkspace}`);
    expect(runCall).toContain("-p 127.0.0.1::6901");
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
