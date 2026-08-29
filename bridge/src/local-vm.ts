import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
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
const BASE_IMAGE = process.env.OMB_BRIDGE_VM_BASE_IMAGE?.trim() ||
  "docker.io/trycua/xfce-cua@sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
const MANAGED_IMAGE = process.env.OMB_BRIDGE_VM_IMAGE?.trim() ||
  `localhost/openmausbot/cua-local-vm:driver-${CUA_DRIVER_VERSION}-v5`;
const VM_WORKSPACE_GUEST = "/home/cua/workspace";

type Runtime = "docker" | "podman";

async function runner(
  command: string,
  args: string[],
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(command, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
    signal,
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

interface LocalVmStatusSnapshot {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback";
  security: "hardened";
  persistence: "durable";
  desktopReady: boolean;
  desktop_error: null;
  create_supported: true;
  ready: boolean;
  problem: string | null;
  container_name: string;
  target_key: string;
  workspace_path: string;
  viewer_port: null;
  viewer_url: string;
}

async function localVmStatus(botId: string): Promise<LocalVmStatusSnapshot> {
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

async function imageExists(runtime: Runtime, ref: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runner(runtime, ["image", "inspect", ref], 8_000, signal);
    return true;
  } catch {
    return false;
  }
}

async function ensureImage(runtime: Runtime, signal?: AbortSignal): Promise<string> {
  if (await imageExists(runtime, MANAGED_IMAGE, signal)) return MANAGED_IMAGE;
  await runner(runtime, ["pull", BASE_IMAGE], 10 * 60_000, signal);
  if (await imageExists(runtime, MANAGED_IMAGE, signal)) return MANAGED_IMAGE;
  return BASE_IMAGE;
}

async function createContainer(runtime: Runtime, botId: string, signal?: AbortSignal): Promise<void> {
  const target = perBotLocalVmTarget(botId);
  mkdirSync(target.workspaceDir, { recursive: true, mode: 0o700 });
  const image = await ensureImage(runtime, signal);
  await runner(
    runtime,
    [
      "run",
      "-d",
      "--name",
      target.containerName,
      "--hostname",
      target.containerName,
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--shm-size",
      "512m",
      "--mount",
      `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`,
      "-p",
      "127.0.0.1::6901",
      image,
    ],
    120_000,
    signal,
  );
}

async function localVmAction(
  botId: string,
  action: "run" | "stop" | "remove" | "recreate",
  signal?: AbortSignal,
): Promise<LocalVmStatusSnapshot> {
  const target = perBotLocalVmTarget(botId);
  const runtime = await detectRuntime();
  if (!runtime) throw new Error("No container runtime is installed");
  if (action === "remove") {
    await runner(runtime, ["rm", "-f", target.containerName], 60_000, signal).catch(() => undefined);
  } else if (action === "recreate") {
    await runner(runtime, ["rm", "-f", target.containerName], 60_000, signal).catch(() => undefined);
    await createContainer(runtime, botId, signal);
  } else if (action === "stop") {
    await runner(runtime, ["stop", target.containerName], 60_000, signal);
  } else if (action === "run") {
    const state = await containerState(runtime, target.containerName);
    if (state === "missing") {
      await createContainer(runtime, botId, signal);
    } else if (state === "stopped") {
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
  signal?: AbortSignal,
): Promise<BridgeJobResult> {
  try {
    const { botId, action } = job.payload;
    if (!botId) throw new Error("botId required");
    if (job.kind === "local-vm-status") {
      return { exitCode: 0, stdout: JSON.stringify(await localVmStatus(botId)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-action") {
      if (!action) throw new Error("action required");
      return { exitCode: 0, stdout: JSON.stringify(await localVmAction(botId, action, signal)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-screenshot") {
      return { exitCode: 0, stdout: JSON.stringify(await localVmScreenshot(botId)), stderr: "", truncated: false };
    }
    return { exitCode: 1, stdout: "", stderr: `unsupported local-vm job: ${job.kind}`, truncated: false };
  } catch (error) {
    // SAFETY: docker/podman execFile rejects with Node's ErrnoException.
    const err = error as NodeJS.ErrnoException;
    const aborted = err.name === "AbortError" || err.code === "ABORT_ERR";
    return {
      exitCode: aborted ? 143 : 1,
      stdout: "",
      stderr: aborted ? "cancelled" : error instanceof Error ? error.message : String(error),
      truncated: false,
    };
  }
}
