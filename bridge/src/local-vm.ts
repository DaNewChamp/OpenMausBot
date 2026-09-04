import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BridgeJobResult, LocalVmBridgeJob } from "./types.ts";
import {
  executeLocalVmInvokeTool,
  isLocalVmInvokeTool,
  parseLocalVmInvokeResult,
  sanitizeLocalVmInvokeText,
} from "../../server/local-vm-invoke.ts";
import {
  BROWSER_VM_CPUS,
  BROWSER_VM_IMAGE,
  BROWSER_VM_KIND,
  BROWSER_VM_KIND_LABEL,
  BROWSER_VM_LAYER_LABEL,
  BROWSER_VM_LAYER_VERSION,
  BROWSER_VM_MEMORY,
  BROWSER_VM_MEMORY_BYTES,
  BROWSER_VM_NANO_CPUS,
  BROWSER_VM_PIDS_LIMIT,
  BROWSER_VM_SHM,
  BROWSER_VM_SHM_BYTES,
  browserCdpExecArgs,
  browserVmDockerfile,
  browserVmImageLabelsMatch,
} from "../../server/browser-vm-image.ts";

const execFileAsync = promisify(execFile);

const LOCAL_VM_CONTAINER = "openmausbot-computer";
const LOCAL_VM_DATA_DIR = process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
const IMAGE = BROWSER_VM_IMAGE;
const MANAGED_LABEL = "com.openmausbot.local-vm";
const WORKSPACE_LABEL = "com.openmausbot.workspace";
const TARGET_LABEL = "com.openmausbot.local-vm-target";
const VM_WORKSPACE_GUEST = "/home/cua/workspace";
const INTERNAL_VIEWER_PORT = 9222;
const MEMORY_BYTES = BROWSER_VM_MEMORY_BYTES;
const NANO_CPUS = BROWSER_VM_NANO_CPUS;
const PIDS_LIMIT = BROWSER_VM_PIDS_LIMIT;
const SHM_BYTES = BROWSER_VM_SHM_BYTES;

export type Runtime = "docker" | "podman";
export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
  signal?: AbortSignal,
) => Promise<{ stdout: string }>;

export interface LocalVmTarget {
  key: string;
  containerName: string;
  workspaceDir: string;
  label: string;
}

/** The harness sends this in place of a bot id when Local VM mode is shared. */
export const SHARED_LOCAL_VM_KEY = "shared";

export const SHARED_LOCAL_VM_TARGET: LocalVmTarget = {
  key: SHARED_LOCAL_VM_KEY,
  containerName: LOCAL_VM_CONTAINER,
  workspaceDir: join(LOCAL_VM_DATA_DIR, "vm-home"),
  label: SHARED_LOCAL_VM_KEY,
};

/** Resolve the harness identity to a container: "shared" is the one fleet VM, anything else is a bot. */
export function localVmTargetFor(botId: string): LocalVmTarget {
  return botId === SHARED_LOCAL_VM_KEY ? SHARED_LOCAL_VM_TARGET : perBotLocalVmTarget(botId);
}

/** Keep bridge identities byte-for-byte compatible with the harness. */
export function perBotLocalVmTarget(botId: string): LocalVmTarget {
  const digest = createHash("sha256").update(botId).digest("hex");
  const short = digest.slice(0, 16);
  return {
    key: `bot:${digest}`,
    containerName: `${LOCAL_VM_CONTAINER}-${short}`,
    workspaceDir: join(LOCAL_VM_DATA_DIR, "vm-homes", short),
    label: digest,
  };
}

const defaultRunner: CommandRunner = async (command, args, timeout = 30_000, signal) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
    signal,
  });
  return { stdout };
};

async function detectRuntime(run: CommandRunner): Promise<Runtime | null> {
  for (const candidate of ["docker", "podman"] as const) {
    try {
      await run(candidate, ["info", "--format", "{{.ServerVersion}}"], 8_000);
      return candidate;
    } catch {
      // Try the other supported runtime.
    }
  }
  return null;
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return browserVmImageLabelsMatch(labels);
}

function containerLabelsMatch(labels: Record<string, string> | undefined, target: LocalVmTarget): boolean {
  return (
    imageLabelsMatch(labels) &&
    labels?.[WORKSPACE_LABEL] === "1" &&
    (target.key === SHARED_LOCAL_VM_KEY
      ? labels?.[TARGET_LABEL] === undefined || labels?.[TARGET_LABEL] === target.label
      : labels?.[TARGET_LABEL] === target.label)
  );
}

function dockerSecurityIsHardened(config: DockerHardeningConfig | undefined): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));
  const restartPolicy = config.RestartPolicy?.Name;
  return (
    config.Memory === MEMORY_BYTES &&
    (config.MemorySwap ?? 0) === MEMORY_BYTES &&
    (config.NanoCpus ?? 0) === NANO_CPUS &&
    config.PidsLimit === PIDS_LIMIT &&
    capDrop.includes("all") &&
    capAdd.join(",") === "setgid,setuid" &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    config.ShmSize === SHM_BYTES &&
    (!config.Devices || config.Devices.length === 0) &&
    (!config.DeviceRequests || config.DeviceRequests.length === 0) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.OomKillDisable !== true &&
    config.AutoRemove !== true &&
    (restartPolicy === undefined || restartPolicy === "" || restartPolicy === "no")
  );
}

function podmanSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  effectiveCaps: string[] | undefined,
  boundingCaps: string[] | undefined,
): boolean {
  if (!config) return false;
  const normalizeCaps = (caps: string[] | undefined) => (caps ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  if (normalizeCaps(effectiveCaps).join(",") !== "setgid,setuid") return false;
  if (normalizeCaps(boundingCaps).join(",") !== "setgid,setuid") return false;
  return dockerSecurityIsHardened({
    ...config,
    CapDrop: ["all"],
    CapAdd: effectiveCaps,
    PidMode: config.PidMode === "private" ? "" : config.PidMode,
    UTSMode: config.UTSMode === "private" ? "" : config.UTSMode,
    CgroupnsMode: config.CgroupnsMode || "private",
  });
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

function dockerViewerPort(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
): number | null {
  const raw = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`]?.find((entry) => loopback(entry.HostIp))?.HostPort;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : null;
}

function sameWorkspaceSource(source: string | undefined, expected: string): boolean {
  return Boolean(source && source === expected);
}

function dockerWorkspaceMountIsSafe(
  mounts: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> | undefined,
  expectedWorkspace: string,
): boolean {
  return Boolean(
    mounts?.length === 1 &&
    mounts[0]?.Type === "bind" &&
    sameWorkspaceSource(mounts[0]?.Source, expectedWorkspace) &&
    mounts[0]?.Destination === VM_WORKSPACE_GUEST &&
    mounts[0]?.RW !== false
  );
}

interface DockerHardeningConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
}

interface InspectImage {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
  config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
  configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
}

interface InspectContainer {
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
  HostConfig?: DockerHardeningConfig & {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
  EffectiveCaps?: string[];
  BoundingCaps?: string[];
  State?: { Running?: boolean };
  Image?: string;
}

interface ImageInspection {
  labels: Record<string, string> | undefined;
  id: string | null;
}

function inspectImage(stdout: string): ImageInspection {
  // SAFETY: Docker/Podman image inspect always returns a JSON array; the
  // optional fields below deliberately tolerate version-specific variants.
  const image = (JSON.parse(stdout) as InspectImage[])[0];
  return {
    labels: image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.configuration?.descriptor?.digest),
  };
}

function parseContainer(stdout: string): InspectContainer {
  // SAFETY: Docker/Podman inspect always returns a JSON array; missing fields
  // are handled as an unsafe status by the checks below.
  return (JSON.parse(stdout) as InspectContainer[])[0] ?? {};
}

interface LocalVmStatus {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  create_supported: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  target_key: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_port: number | null;
  viewer_url: string;
}

function emptyStatus(target: LocalVmTarget): LocalVmStatus {
  return {
    platform: process.platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    create_supported: true,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    base_image_ref: "debian:bookworm-slim",
    driver_version: `browser-${BROWSER_VM_LAYER_VERSION}`,
    container_name: target.containerName,
    target_key: target.key,
    workspace_path: target.workspaceDir,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_port: null,
    viewer_url: "",
  };
}

function statusProblem(status: LocalVmStatus): string | null {
  if (!status.runtime) return "Install a supported container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  if (!status.image) return "Prepare the browser VM image (Deploy builds it on first use)";
  if (status.container === "missing") return "Create the Local VM";
  if (!status.imageMatches) return "The existing Local VM uses an older browser image; recreate it";
  if (!status.managed) return "The existing container was not created by OpenMausBot; recreate it";
  if (status.network === "unsafe") return "The existing Local VM exposes its debugger publicly; recreate it";
  if (status.security === "unsafe") return "The existing Local VM is missing safety limits; recreate it";
  if (status.persistence === "unsafe") return "The existing Local VM is missing its durable workspace; recreate it";
  if (status.container === "stopped") return "This browser VM cannot safely resume; recreate the Local VM";
  if (status.desktop_error) return `The browser VM failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The browser VM started, but Chromium is not ready yet";
  return null;
}

function wholeScreenshot(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length < 512) return null;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png && bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii"))) return "image/png";
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9]))) return "image/jpeg";
  return null;
}

async function cuaReady(
  runtime: Runtime,
  containerName: string,
  run: CommandRunner,
): Promise<{ ready: boolean; error: string | null }> {
  try {
    const version = await run(
      runtime,
      ["exec", "-u", "cua", containerName, "curl", "-sf", "--max-time", "2", "http://127.0.0.1:9222/json/version"],
      8_000,
    );
    if (!/"Browser"\s*:/.test(version.stdout) && !/"webSocketDebuggerUrl"\s*:/.test(version.stdout)) {
      throw new Error("Chromium DevTools is not answering");
    }
    await run(runtime, browserCdpExecArgs("screenshot", {}, { container: containerName }), 20_000);
    const captured = await run(runtime, ["exec", containerName, "base64", "-w0", "/tmp/openmausbot-preview.jpg"], 20_000);
    if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64"))) {
      throw new Error("Chromium returned an incomplete readiness screenshot");
    }
    return { ready: true, error: null };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message.slice(0, 320) : String(error).slice(0, 320) };
  }
}

async function localVmStatus(botId: string, run: CommandRunner): Promise<LocalVmStatus> {
  const target = localVmTargetFor(botId);
  const status = emptyStatus(target);
  const runtime = await detectRuntime(run);
  status.runtime = runtime;
  status.available = runtime ? [runtime] : [];
  status.daemonUp = Boolean(runtime);
  if (!runtime) return status;

  let imageId: string | null = null;
  try {
    const image = inspectImage((await run(runtime, ["image", "inspect", IMAGE], 8_000)).stdout);
    status.image = imageLabelsMatch(image.labels);
    imageId = image.id;
    status.image_id = image.id;
  } catch {
    // The managed image is not present on this bridge host.
  }

  let detail: InspectContainer | null = null;
  try {
    detail = parseContainer((await run(runtime, ["inspect", target.containerName], 8_000)).stdout);
    status.container = detail.State?.Running ? "running" : "stopped";
    status.network = detail.HostConfig?.PortBindings === undefined
      ? "unknown"
      : dockerPortsAreLocal(detail.HostConfig.PortBindings)
        ? "loopback"
        : "unsafe";
    status.viewer_port = dockerViewerPort(detail.NetworkSettings?.Ports ?? detail.HostConfig?.PortBindings);
    status.imageMatches =
      detail.Config?.Image === IMAGE &&
      imageLabelsMatch(detail.Config?.Labels) &&
      imageId !== null &&
      normalizeImageId(detail.Image) === imageId;
    status.managed = containerLabelsMatch(detail.Config?.Labels, target);
    status.persistence = dockerWorkspaceMountIsSafe(detail.Mounts, target.workspaceDir) ? "durable" : "unsafe";
    status.security = runtime === "podman"
      ? podmanSecurityIsHardened(detail.HostConfig, detail.EffectiveCaps, detail.BoundingCaps)
        ? "hardened"
        : "unsafe"
      : dockerSecurityIsHardened(detail.HostConfig)
        ? "hardened"
        : "unsafe";
    status.viewer_url = "";
  } catch {
    // No per-bot container with this derived name.
  }

  if (detail && status.container === "running" && status.imageMatches && status.managed && status.network === "loopback" && status.security === "hardened" && status.persistence === "durable") {
    const readiness = await cuaReady(runtime, target.containerName, run);
    status.desktopReady = readiness.ready;
    status.desktop_error = readiness.error;
  }
  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

function containerRunArgs(runtime: Runtime, target: LocalVmTarget): string[] {
  const common = [
    "run",
    "-d",
    "--name",
    target.containerName,
    "--hostname",
    target.containerName,
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${BROWSER_VM_KIND_LABEL}=${BROWSER_VM_KIND}`,
    "--label",
    `${BROWSER_VM_LAYER_LABEL}=${BROWSER_VM_LAYER_VERSION}`,
    "--label",
    `${WORKSPACE_LABEL}=1`,
    "--label",
    `${TARGET_LABEL}=${target.label}`,
    "--memory",
    BROWSER_VM_MEMORY,
    "--memory-swap",
    BROWSER_VM_MEMORY,
    "--cpus",
    BROWSER_VM_CPUS,
    "--pids-limit",
    String(PIDS_LIMIT),
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--shm-size",
    BROWSER_VM_SHM,
    "--mount",
    runtime === "podman"
      ? `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`
      : `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`,
    "-p",
    `127.0.0.1::${INTERNAL_VIEWER_PORT}`,
    IMAGE,
  ];
  return common;
}

async function ensureVmWorkspace(target: LocalVmTarget): Promise<void> {
  await mkdir(target.workspaceDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(target.workspaceDir, 0o700);
}

async function removeContainer(runtime: Runtime, target: LocalVmTarget, run: CommandRunner): Promise<void> {
  await run(runtime, ["rm", "-f", target.containerName], 60_000).catch(() => undefined);
}

async function prepareBrowserImage(runtime: Runtime, run: CommandRunner): Promise<void> {
  const context = await mkdtemp(join(tmpdir(), "openmausbot-browser-vm-"));
  try {
    await writeFile(join(context, "Dockerfile"), browserVmDockerfile(), { mode: 0o600 });
    await run(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

async function createContainer(runtime: Runtime, target: LocalVmTarget, run: CommandRunner): Promise<void> {
  await ensureVmWorkspace(target);
  try {
    await run(runtime, containerRunArgs(runtime, target), 2 * 60_000);
  } catch (error) {
    // Do not leave a partially-created, unvalidated container behind after a
    // daemon error. The durable workspace is intentionally preserved.
    await removeContainer(runtime, target, run);
    throw error;
  }
}

async function localVmAction(
  botId: string,
  action: "run" | "stop" | "remove" | "recreate",
  run: CommandRunner,
): Promise<LocalVmStatus> {
  const target = localVmTargetFor(botId);
  const before = await localVmStatus(botId, run);
  const runtime = before.runtime;
  if (!runtime) throw new Error(before.problem ?? "No container runtime is installed");

  if (action === "remove") {
    if (before.container !== "missing") await removeContainer(runtime, target, run);
    return localVmStatus(botId, run);
  }
  if (action === "stop") {
    if (before.container !== "running") throw new Error("The Local VM is not running");
    await run(runtime, ["stop", target.containerName], 60_000);
    return localVmStatus(botId, run);
  }
  if (!before.image) await prepareBrowserImage(runtime, run);
  if (action === "run" && before.container !== "missing") {
    throw new Error("A Local VM already exists; remove it before creating a replacement");
  }
  if (action === "recreate" && before.container !== "missing") await removeContainer(runtime, target, run);
  await createContainer(runtime, target, run);
  return localVmStatus(botId, run);
}

async function localVmScreenshot(botId: string, run: CommandRunner): Promise<{ image: string }> {
  const status = await localVmStatus(botId, run);
  if (!status.ready || !status.runtime) throw new Error(status.problem ?? "The Local VM is not ready");
  const target = localVmTargetFor(botId);
  const screenshot = "/tmp/openmausbot-preview.jpg";
  await run(
    status.runtime,
    browserCdpExecArgs("screenshot", {}, { container: target.containerName }),
    30_000,
  );
  const captured = await run(status.runtime, ["exec", target.containerName, "base64", "-w0", screenshot], 30_000);
  const data = captured.stdout.trim();
  const mime = wholeScreenshot(Buffer.from(data, "base64"));
  if (!mime) throw new Error("Chromium returned an incomplete screenshot");
  return { image: `data:${mime};base64,${data}` };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; code?: string };
  return err.name === "AbortError" || err.code === "ABORT_ERR";
}

async function localVmInvoke(
  job: LocalVmBridgeJob,
  run: CommandRunner,
  signal?: AbortSignal,
): Promise<BridgeJobResult> {
  const { botId, tool } = job.payload;
  if (!botId) throw new Error("botId required");
  if (!tool || !isLocalVmInvokeTool(tool)) {
    throw new Error("that computer tool is not available on this bot's Local VM");
  }
  if (signal?.aborted) {
    const abortErr = new Error("cancelled");
    abortErr.name = "AbortError";
    throw abortErr;
  }
  let status = await localVmStatus(botId, run);
  if (status.container !== "missing" && (!status.managed || !status.imageMatches)) {
    throw new Error(
      status.problem ??
        "The existing Local VM is incompatible with this browser image. Recreate it from Settings. This action will not delete it.",
    );
  }
  if (status.container === "missing") {
    status = await localVmAction(botId, "run", run);
  }
  if (status.container !== "missing" && (!status.managed || !status.imageMatches)) {
    throw new Error(
      status.problem ??
        "The existing Local VM is incompatible with this browser image. Recreate it from Settings. This action will not delete it.",
    );
  }
  if (!status.ready || !status.runtime) {
    throw new Error(status.problem ?? "The Local VM is not ready");
  }
  const target = localVmTargetFor(botId);
  const rawArgs = job.payload.arguments;
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  const execution = await executeLocalVmInvokeTool(tool, args, {
    runtime: status.runtime,
    containerName: target.containerName,
    runner: (command, commandArgs, timeout, innerSignal) =>
      run(command, commandArgs, timeout, innerSignal ?? signal),
    signal,
  });
  const parsed = parseLocalVmInvokeResult({
    text: sanitizeLocalVmInvokeText(execution.text),
    isError: execution.isError,
    ...(execution.image ? { image: execution.image } : {}),
    ...(execution.imageMimeType ? { imageMimeType: execution.imageMimeType } : {}),
  });
  if (!parsed) throw new Error("local-vm invoke returned an invalid result");
  return { exitCode: 0, stdout: JSON.stringify(parsed), stderr: "", truncated: false };
}

export async function runLocalVmJob(
  job: LocalVmBridgeJob,
  run: CommandRunner = defaultRunner,
  signal?: AbortSignal,
  beforeCommand?: () => Promise<void>,
): Promise<BridgeJobResult> {
  try {
    const { botId, action } = job.payload;
    if (!botId) throw new Error("botId required");
    if (job.kind === "local-vm-status") {
      return { exitCode: 0, stdout: JSON.stringify(await localVmStatus(botId, run)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-action") {
      if (!action) throw new Error("action required");
      return { exitCode: 0, stdout: JSON.stringify(await localVmAction(botId, action, run)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-screenshot") {
      return { exitCode: 0, stdout: JSON.stringify(await localVmScreenshot(botId, run)), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-input") {
      const input = job.payload.input;
      if (!input) throw new Error("input required");
      const status = await localVmStatus(botId, run);
      if (!status.ready || !status.runtime) throw new Error(status.problem ?? "The Local VM is not ready");
      const target = localVmTargetFor(botId);
      const action =
        input.action === "click"
          ? "mouse"
          : input.action === "type"
            ? "type"
            : input.action === "scroll"
              ? "scroll"
              : "key";
      const payload =
        input.action === "click"
          ? { x: input.x, y: input.y, button: input.button ?? "left", double: input.double === true }
          : input.action === "scroll"
            ? { direction: input.direction ?? "down", clicks: input.clicks ?? 3, x: input.x, y: input.y }
            : input.action === "type"
              ? { text: input.text }
              : { keys: input.keys };
      await run(status.runtime, browserCdpExecArgs(action, payload, { container: target.containerName }), 30_000, signal);
      return { exitCode: 0, stdout: JSON.stringify({ text: "ok", isError: false }), stderr: "", truncated: false };
    }
    if (job.kind === "local-vm-invoke") {
      const checkedRun: CommandRunner = async (command, args, timeout, commandSignal) => {
        const activeSignal = commandSignal ?? signal;
        activeSignal?.throwIfAborted();
        await beforeCommand?.();
        activeSignal?.throwIfAborted();
        return run(command, args, timeout, activeSignal);
      };
      await beforeCommand?.();
      return await localVmInvoke(job, checkedRun, signal);
    }
    return { exitCode: 1, stdout: "", stderr: `unsupported local-vm job: ${job.kind}`, truncated: false };
  } catch (error) {
    const aborted = isAbortError(error) || signal?.aborted === true;
    return {
      exitCode: aborted ? 143 : 1,
      stdout: "",
      stderr: aborted ? "cancelled" : (error instanceof Error ? error.message : String(error)),
      truncated: false,
    };
  }
}
