import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BridgeJobResult, LocalVmBridgeJob } from "./types.ts";

const execFileAsync = promisify(execFile);

const LOCAL_VM_CONTAINER = "openmausbot-computer";
const LOCAL_VM_DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");

interface LocalVmTarget {
  key: string;
  containerName: string;
  workspaceDir: string;
  label: string;
}

/** Same naming contract as server/container-computer.ts perBotLocalVmTarget. */
function perBotLocalVmTarget(botId: string): LocalVmTarget {
  const digest = createHash("sha256").update(botId).digest("hex");
  const short = digest.slice(0, 16);
  return {
    key: `bot:${digest}`,
    containerName: `${LOCAL_VM_CONTAINER}-${short}`,
    workspaceDir: join(LOCAL_VM_DATA_DIR, "vm-homes", short),
    label: digest,
  };
}

const CUA_SOCKET = "/run/user/1000/openmausbot-cua.sock";
const CUA_EXECUTABLE = "/usr/local/libexec/openmausbot/cua-driver";
const CUA_DRIVER_VERSION = "0.20.0";

type Runtime = "docker" | "podman";

async function runner(command: string, args: string[], timeout = 30_000): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(command, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return { stdout };
}

async function detectRuntime(): Promise<Runtime | null> {
  for (const candidate of ["docker", "podman"] as const) {
    try {
      await runner(candidate, ["info", "--format", "{{.ServerVersion}}"], 8_000);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function containerState(runtime: Runtime, containerName: string): Promise<"running" | "stopped" | "missing"> {
  try {
    const { stdout } = await runner(runtime, ["inspect", "-f", "{{.State.Running}}", containerName], 8_000);
    return stdout.trim() === "true" ? "running" : "stopped";
  } catch {
    return "missing";
  }
}

async function cuaReady(runtime: Runtime, containerName: string): Promise<boolean> {
  try {
    const version = await runner(
      runtime,
      [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        "-e",
        "DISPLAY=:1",
        containerName,
        CUA_EXECUTABLE,
        "--version",
      ],
      8_000,
    );
    if (version.stdout.trim() !== `cua-driver ${CUA_DRIVER_VERSION}`) return false;
    await runner(
      runtime,
      [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        "-e",
        "DISPLAY=:1",
        containerName,
        CUA_EXECUTABLE,
        "status",
        "--socket",
        CUA_SOCKET,
      ],
      8_000,
    );
    return true;
  } catch {
    return false;
  }
}

async function localVmStatus(botId: string): Promise<Record<string, unknown>> {
  const target = perBotLocalVmTarget(botId);
  const runtime = await detectRuntime();
  const container = runtime ? await containerState(runtime, target.containerName) : "missing";
  const desktopReady = runtime && container === "running" ? await cuaReady(runtime, target.containerName) : false;
  const ready = container === "running" && desktopReady;
  let problem: string | null = null;
  if (!runtime) problem = "Install a supported container runtime first";
  else if (container === "missing") problem = "Create this bot's Local VM";
  else if (container === "stopped") problem = "This desktop image cannot safely resume; recreate the Local VM";
  else if (!desktopReady) problem = "The Local VM started, but Cua Driver is not ready yet";

  return {
    platform: process.platform,
    runtime,
    available: runtime ? [runtime] : [],
    daemonUp: Boolean(runtime),
    image: true,
    imageMatches: true,
    managed: container !== "missing",
    container,
    network: "loopback",
    security: "hardened",
    persistence: "durable",
    desktopReady,
    desktop_error: null,
    create_supported: true,
    ready,
    problem,
    container_name: target.containerName,
    target_key: target.key,
    workspace_path: target.workspaceDir,
    viewer_port: null,
    viewer_url: "",
  };
}

async function localVmAction(botId: string, action: "run" | "stop" | "remove" | "recreate"): Promise<Record<string, unknown>> {
  const target = perBotLocalVmTarget(botId);
  const runtime = await detectRuntime();
  if (!runtime) throw new Error("No container runtime is installed");
  const normalized = action === "recreate" ? "remove" : action;
  if (normalized === "remove") {
    await runner(runtime, ["rm", "-f", target.containerName], 60_000).catch(() => undefined);
    if (action === "recreate") {
      throw new Error("recreate requires a prepared Local VM image on the bridge host — run create locally first");
    }
  } else if (normalized === "stop") {
    await runner(runtime, ["stop", target.containerName], 60_000);
  } else if (normalized === "run") {
    const state = await containerState(runtime, target.containerName);
    if (state === "missing") {
      throw new Error("No Local VM container exists on the bridge — create it on the bridge host first");
    }
    if (state === "stopped") {
      throw new Error("This desktop image cannot safely resume; recreate the Local VM");
    }
  }
  return localVmStatus(botId);
}

async function localVmScreenshot(botId: string): Promise<{ image: string }> {
  const target = perBotLocalVmTarget(botId);
  const runtime = await detectRuntime();
  if (!runtime) throw new Error("No container runtime is installed");
  const state = await containerState(runtime, target.containerName);
  if (state !== "running") throw new Error("The Local VM is not running");
  const screenshot = "/tmp/openmausbot-preview.png";
  await runner(
    runtime,
    [
      "exec",
      "-u",
      "cua",
      "-e",
      "HOME=/home/cua",
      "-e",
      "DISPLAY=:1",
      target.containerName,
      CUA_EXECUTABLE,
      "call",
      "get_desktop_state",
      "{}",
      "--socket",
      CUA_SOCKET,
      "--screenshot-out-file",
      screenshot,
    ],
    30_000,
  );
  const { stdout } = await runner(runtime, ["exec", target.containerName, "base64", "-w0", screenshot], 30_000);
  const data = stdout.trim();
  return { image: `data:image/jpeg;base64,${data}` };
}

export async function runLocalVmJob(
  job: LocalVmBridgeJob,
): Promise<BridgeJobResult> {
  try {
    const { botId, action } = job.payload;
    if (!botId) throw new Error("botId required");
    if (job.kind === "local-vm-status") {
      return { exitCode: 0, stdout: JSON.stringify(await localVmStatus(botId)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-action") {
      if (!action) throw new Error("action required");
      return { exitCode: 0, stdout: JSON.stringify(await localVmAction(botId, action)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-screenshot") {
      return { exitCode: 0, stdout: JSON.stringify(await localVmScreenshot(botId)), stderr: "", truncated: false };
    }
    return { exitCode: 1, stdout: "", stderr: `unsupported local-vm job: ${job.kind}`, truncated: false };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      truncated: false,
    };
  }
}
