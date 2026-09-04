import { describe, expect, it } from "vitest";

import {
  localVmTargetFor,
  perBotLocalVmTarget,
  runLocalVmJob,
  SHARED_LOCAL_VM_TARGET,
  type CommandRunner,
  type LocalVmTarget,
} from "../bridge/src/local-vm.ts";
import type { LocalVmBridgeJob } from "../bridge/src/types.ts";

const image = "localhost/openmausbot/browser-vm:v1";
const guestWorkspace = "/home/cua/workspace";

const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.alloc(600),
  Buffer.from([0xff, 0xd9]),
]);

function job(action: "run" | "recreate", botId = "bot-test"): LocalVmBridgeJob {
  return {
    id: `job-${action}`,
    bridgeId: "bridge",
    timeoutMs: 120_000,
    createdAt: Date.now(),
    kind: "local-vm-action",
    payload: { botId, action },
  };
}

function statusJob(botId = "shared"): LocalVmBridgeJob {
  return {
    id: "job-status",
    bridgeId: "bridge",
    timeoutMs: 120_000,
    createdAt: Date.now(),
    kind: "local-vm-status",
    payload: { botId },
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

function runningContainer(target: LocalVmTarget, options?: { omitTargetLabel?: boolean }) {
  const labels: Record<string, string> = {
    "com.openmausbot.local-vm": "1",
    "com.openmausbot.computer-kind": "browser",
    "com.openmausbot.image-layer": "1",
    "com.openmausbot.workspace": "1",
  };
  if (!options?.omitTargetLabel) {
    labels["com.openmausbot.local-vm-target"] = target.label;
  }
  return JSON.stringify([{
    Config: {
      Image: image,
      Labels: labels,
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

function fakeRuntime(
  initiallyCreated: boolean,
  target: LocalVmTarget = perBotLocalVmTarget("bot-test"),
  options?: { omitTargetLabel?: boolean },
) {
  let created = initiallyCreated;
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (command === "docker" && args[0] === "info") return { stdout: "29\n" };
    if (command === "docker" && args[0] === "image") return { stdout: preparedImage() };
    if (command === "docker" && args[0] === "inspect" && args[1] === target.containerName) {
      if (!created) throw new Error("No such container");
      return { stdout: runningContainer(target, options) };
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
    if (command === "docker" && args[0] === "exec" && args.includes("bash") && args.at(-1) === "id") {
      return { stdout: "uid=1000(cua) gid=1000(cua)\n" };
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

  it("creates a missing shared VM with openmausbot-computer name, target label, and /vm-home mount", async () => {
    const target = localVmTargetFor("shared");
    const fake = fakeRuntime(false, target);
    const result = await runLocalVmJob(job("run", "shared"), fake.run);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ container: "running", ready: true, desktopReady: true });
    const runCall = fake.calls.find((call) => call.startsWith("docker run ")) ?? "";
    expect(runCall).toContain("--name openmausbot-computer");
    expect(runCall).toContain("--label com.openmausbot.local-vm-target=shared");
    expect(runCall).toContain(`--mount type=bind,source=${SHARED_LOCAL_VM_TARGET.workspaceDir}`);
    expect(SHARED_LOCAL_VM_TARGET.workspaceDir.endsWith("/vm-home")).toBe(true);
    expect(runCall).not.toContain("/vm-homes");
  });

  it("treats a running container with no target label as managed in shared status", async () => {
    const fake = fakeRuntime(true, SHARED_LOCAL_VM_TARGET, { omitTargetLabel: true });
    const result = await runLocalVmJob(statusJob("shared"), fake.run);

    expect(result.exitCode).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.container).toBe("running");
    expect(status.managed).toBe(true);
    expect(status.ready).toBe(true);

    const perBotFake = fakeRuntime(true, perBotLocalVmTarget("bot-test"), { omitTargetLabel: true });
    const perBotResult = await runLocalVmJob(statusJob("bot-test"), perBotFake.run);
    expect(perBotResult.exitCode).toBe(0);
    const perBotStatus = JSON.parse(perBotResult.stdout);
    expect(perBotStatus.managed).toBe(false);
    expect(perBotStatus.ready).toBe(false);
  });

  function invokeJob(
    tool: string,
    args: Record<string, unknown> = {},
    botId = "shared",
  ): LocalVmBridgeJob {
    return {
      id: "job-invoke",
      bridgeId: "bridge",
      timeoutMs: 120_000,
      createdAt: Date.now(),
      kind: "local-vm-invoke",
      payload: { botId, tool, arguments: args, threadId: "thread-1" },
    } as LocalVmBridgeJob;
  }

  function cuaContainer(target: LocalVmTarget) {
    return JSON.stringify([{
      Config: {
        Image: "docker.io/trycua/xfce-cua:latest",
        Labels: {
          "com.openmausbot.local-vm": "1",
        },
      },
      HostConfig: {
        Memory: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        Privileged: false,
      },
      Mounts: [{ Type: "bind", Source: target.workspaceDir, Destination: guestWorkspace, RW: true }],
      State: { Running: true },
      Image: "sha256:cua-old",
    }]);
  }

  it("dispatches a click through CDP on the shared VM", async () => {
    const target = localVmTargetFor("shared");
    const fake = fakeRuntime(true, target);
    const result = await runLocalVmJob({
      id: "job-input",
      bridgeId: "bridge",
      timeoutMs: 90_000,
      createdAt: Date.now(),
      kind: "local-vm-input",
      payload: { botId: "shared", input: { action: "click", x: 100, y: 100, button: "left" } },
    }, fake.run);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ text: "ok", isError: false });
    expect(fake.calls.some((call) => call.includes("openmausbot-cdp.mjs"))).toBe(true);
  });

  it("executes native tools inside the managed container as cua in /home/cua/workspace", async () => {
    const target = localVmTargetFor("shared");
    const fake = fakeRuntime(true, target);
    const result = await runLocalVmJob(
      invokeJob("computer_exec", { command: "id" }, "shared"),
      fake.run,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ isError: false });
    const execCall = fake.calls.find((call) => call.includes("bash -lc")) ?? "";
    expect(execCall).toContain("-u cua");
    expect(execCall).toContain("-w /home/cua/workspace");
    expect(execCall).toContain("openmausbot-computer");
    expect(execCall).toMatch(/^docker exec -u cua -w \/home\/cua\/workspace -e HOME=\/home\/cua openmausbot-computer bash -lc id$/);
  });

  it("uses the per-bot container name for per-bot native invoke", async () => {
    const target = perBotLocalVmTarget("bot-test");
    const fake = fakeRuntime(true, target);
    const result = await runLocalVmJob(
      invokeJob("open_url", { url: "https://example.com/per-bot" }, "bot-test"),
      fake.run,
    );
    expect(result.exitCode).toBe(0);
    expect(fake.calls.some((call) => call.includes(target.containerName) && call.includes("openmausbot-cdp.mjs"))).toBe(true);
    expect(fake.calls.some((call) => call.includes(" --name openmausbot-computer ") && !call.includes(target.containerName))).toBe(false);
  });

  it("blocks native invoke on an incompatible existing Cua container without removing it", async () => {
    const target = SHARED_LOCAL_VM_TARGET;
    const calls: string[] = [];
    const run: CommandRunner = async (command, args) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      if (command === "docker" && args[0] === "info") return { stdout: "29\n" };
      if (command === "docker" && args[0] === "image") return { stdout: preparedImage() };
      if (command === "docker" && args[0] === "inspect" && args[1] === target.containerName) {
        return { stdout: cuaContainer(target) };
      }
      throw new Error(`unexpected command: ${key}`);
    };
    const result = await runLocalVmJob(invokeJob("open_url", { url: "https://example.com" }), run);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/incompatible|not created by OpenMausBot|recreate/i);
    expect(calls.some((call) => call.startsWith("docker rm") || call.startsWith("docker run") || call.startsWith("docker stop"))).toBe(false);
  });

  it("returns JPEG MIME on native screenshot invoke", async () => {
    const target = localVmTargetFor("shared");
    const fake = fakeRuntime(true, target);
    const result = await runLocalVmJob(invokeJob("screenshot"), fake.run);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      isError: false,
      imageMimeType: "image/jpeg",
    });
    expect(typeof JSON.parse(result.stdout).image).toBe("string");
  });

  it("passes AbortSignal through to docker exec and does not claim remote process death", async () => {
    const target = localVmTargetFor("shared");
    const fake = fakeRuntime(true, target);
    const seen: AbortSignal[] = [];
    const run: CommandRunner = async (command, args, timeout, signal) => {
      if (signal) seen.push(signal);
      if (args.includes("bash") && args.includes("-lc")) {
        controller.abort();
        const err = new Error("aborted") as NodeJS.ErrnoException;
        err.name = "AbortError";
        err.code = "ABORT_ERR";
        throw err;
      }
      return fake.run(command, args, timeout);
    };
    const controller = new AbortController();
    const result = await runLocalVmJob(invokeJob("computer_exec", { command: "sleep 30" }), run, controller.signal);
    expect(seen).toContain(controller.signal);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(/cancel|abort/);
    expect(result.stderr.toLowerCase()).not.toMatch(/killed the process|guaranteed|terminated the remote process/);
  });

  it("rechecks bridge permission after readiness before dispatching native input", async () => {
    const fake = fakeRuntime(true, SHARED_LOCAL_VM_TARGET);
    let held = false;
    const run: CommandRunner = async (command, args, timeout, signal) => {
      const result = await fake.run(command, args, timeout, signal);
      if (args.some(arg => arg.includes("json/version"))) held = true;
      return result;
    };
    const native: LocalVmBridgeJob = {
      id: "preflight-ready-race", bridgeId: "bridge", timeoutMs: 1000, createdAt: Date.now(),
      kind: "local-vm-invoke", payload: { botId: "shared", threadId: "turn", tool: "open_url", arguments: { url: "https://example.com" } },
    };
    const result = await runLocalVmJob(native, run, undefined, async () => {
      if (held) throw new Error("human has taken control");
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("taken control");
    expect(fake.calls.filter(call => call.includes("openmausbot-cdp.mjs"))).toEqual([]);
  });

  it("dispatches nothing for an already cancelled native job", async () => {
    const fake = fakeRuntime(true, SHARED_LOCAL_VM_TARGET);
    const controller = new AbortController();
    controller.abort();
    const result = await runLocalVmJob(invokeJob("computer_exec", { command: "id" }), fake.run, controller.signal);
    expect(result.exitCode).toBe(143);
    expect(fake.calls).toEqual([]);
  });
});
