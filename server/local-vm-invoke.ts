// Bounded, capability-gated contract for a bot using its own Local VM.
//
// A bot with computer: "vm" must be able to discover and use that computer
// during an ordinary turn — "open Google on your computer" — without a UI
// picker and without falling through to the user's Mac. Phrase matching is
// deliberately absent: the model infers from this prompt plus the static
// computer tools. First computer tool call lazily ensures the VM is ready.

import { redactSecretsInText } from "./redact.ts";
import { normalizeBrowserUrl, safeBrowserUrl } from "./computer-observation.ts";
import { browserCdpExecArgs } from "./browser-vm-image.ts";
import {
  type CommandRunner,
  type Runtime,
} from "./container-computer.ts";

export type BotComputer = "cloud" | "vm" | "local" | "off" | undefined;
export type LocalVmMode = "shared" | "per-bot";
export type LocalVmMount = "vm";

export interface LocalVmTurnContract {
  error: string | null;
  prompt: string;
  exposeTools: boolean;
  mount: LocalVmMount | null;
  /** Explicit Local VM turns must never attach host CUA. */
  allowHostFallback: boolean;
}

export interface LocalVmEnsureStatus {
  ready: boolean;
  container: "running" | "stopped" | "missing";
  image: boolean;
  daemonUp: boolean;
  runtime: Runtime | null;
  create_supported: boolean;
}

export type LocalVmEnsureDecision =
  | { action: "ready" }
  | { action: "wait"; message: string }
  | { action: "create" }
  | { action: "recreate" }
  | { action: "blocked"; message: string };

export type LocalVmEnsureResult =
  | { state: "ready" }
  | { state: "starting"; retryable: true; message: string }
  | { state: "blocked"; retryable: false; message: string };

export const LOCAL_VM_STARTING_MESSAGE =
  "The Local VM is still starting. Retry the exact same computer action shortly. Do not control the user's machine.";

const HOST_ENGINE_ERROR =
  "this model engine cannot use the Local VM — choose Claude or an ACP engine, or select another computer destination";

export const LOCAL_VM_INVOKE_TOOLS = [
  {
    name: "screenshot",
    description:
      "See this bot's own browser. This is not the user's Mac. Capture the page before clicking or typing.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_desktop_state",
    description:
      "Inspect the page's accessibility targets in this bot's browser. Prefer this over raw coordinates. This is not the user's Mac.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description: "Click in this bot's browser. Use coordinates from the last screenshot or page snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], description: "default left" },
        double: { type: "boolean" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Type text at the current focus in this bot's browser. Never type the user's passwords.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description: "Press a key or chord in this bot's browser, e.g. Return, Tab, ctrl+l.",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "string" } },
      required: ["keys"],
    },
  },
  {
    name: "launch_app",
    description:
      "Open an application inside this bot's Linux container. The browser is already running; use open_url for sites. This cannot launch apps on the user's Mac.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string" } },
      required: ["app"],
    },
  },
  {
    name: "open_url",
    description:
      "Open an http(s) URL in this bot's browser. Use this when the user asks you to browse or open a site on your computer. This is not the user's Mac.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "computer_exec",
    description:
      "Run a shell command on this bot's Linux container (git, node, scripts). Returns stdout/stderr/exit code. This is not the user's Mac. Durable files live in /home/cua/workspace.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
] as const;

export const LOCAL_VM_INVOKE_TOOL_NAMES = LOCAL_VM_INVOKE_TOOLS.map((tool) => tool.name);
const LOCAL_VM_INVOKE_TOOL_SET = new Set<string>(LOCAL_VM_INVOKE_TOOL_NAMES);

export function botOwnsLocalVm(computer: BotComputer): boolean {
  return computer === "vm";
}

/** Prompt shown only when the bot's destination is its own Local VM. */
export function localVmSelfInvokePrompt(mode: LocalVmMode): string {
  const ownership =
    mode === "per-bot"
      ? "You have your own isolated Linux computer: a headless Chromium browser plus a shell in a container reserved for this bot."
      : "You have a shared, isolated Linux computer: a headless Chromium browser plus a shell in a container.";
  return (
    ` ${ownership}` +
    " This is YOUR computer, not the user's Mac or Windows desktop. Never inspect, click, type, or otherwise control the user's host OS, and never fall back to it." +
    " Only /home/cua/workspace is durable; clone repositories, save files, and keep git remotes there because everything else inside the VM is disposable. No other host folder is mounted." +
    " When a request needs this computer — browsing, opening a site, clicking, typing, or running CLI commands — use the computer and browser tools immediately. Do not ask whether you should use them, and do not wait for a tool picker." +
    " If a tool reports that the Local VM is still starting or booting, it is a retryable starting state: wait briefly and retry the exact same computer action on this VM. Do not give up or fall back to the user's machine." +
    " Inspect page state before acting, prefer accessibility targets over raw coordinates, and work carefully. Use computer_exec for git, builds, and other shell work."
  );
}

export function localVmTurnContract(input: {
  computer: BotComputer;
  mountsComputerMcp: boolean;
  driverKind: string;
  mode?: LocalVmMode;
}): LocalVmTurnContract {
  if (input.computer !== "vm") {
    return { error: null, prompt: "", exposeTools: false, mount: null, allowHostFallback: true };
  }
  if (!input.mountsComputerMcp || input.driverKind === "boxAgent") {
    return {
      error: HOST_ENGINE_ERROR,
      prompt: "",
      exposeTools: false,
      mount: null,
      allowHostFallback: false,
    };
  }
  return {
    error: null,
    prompt: localVmSelfInvokePrompt(input.mode ?? "shared"),
    exposeTools: true,
    mount: "vm",
    allowHostFallback: false,
  };
}

export function localComputerMountIsHost(localComputer: { scope?: string } | null | undefined): boolean {
  return localComputer?.scope === "local-computer";
}

export function localComputerMountIsVm(localComputer: { scope?: string } | null | undefined): boolean {
  return localComputer?.scope === "local-vm";
}

export function decideLocalVmEnsure(input: {
  status: LocalVmEnsureStatus;
  lifecycleBusy: boolean;
  imageBusy: boolean;
  modeChangeBusy: boolean;
  provisionBusy: boolean;
  leaseOwnedByThisTurn: boolean;
  existingCount: number;
  maxInstances: number;
  mode: LocalVmMode;
  targetExists: boolean;
}): LocalVmEnsureDecision {
  if (!input.leaseOwnedByThisTurn) {
    return { action: "blocked", message: "this Local VM is already being used by another turn — wait for that turn to finish" };
  }
  if (input.imageBusy || input.modeChangeBusy) {
    return { action: "wait", message: "this Local VM is being prepared — retry the exact same computer action shortly" };
  }
  if (input.lifecycleBusy) {
    return { action: "wait", message: LOCAL_VM_STARTING_MESSAGE };
  }
  if (!input.status.runtime || !input.status.daemonUp) {
    return { action: "blocked", message: "Start the container runtime on the computer before using the Local VM." };
  }
  if (!input.status.image) {
    return { action: "blocked", message: "Prepare the Local VM image on the computer before using it." };
  }
  if (input.status.ready) return { action: "ready" };
  if (input.status.container === "running") {
    return { action: "wait", message: LOCAL_VM_STARTING_MESSAGE };
  }
  if (input.status.container === "stopped") return { action: "recreate" };
  if (!input.status.create_supported) {
    return { action: "blocked", message: "This runtime cannot create a per-bot Local VM." };
  }
  if (input.provisionBusy) {
    return { action: "wait", message: "another Local VM is being created — retry the exact same computer action shortly" };
  }
  if (input.mode === "per-bot" && !input.targetExists && input.existingCount >= input.maxInstances) {
    return {
      action: "blocked",
      message: `The per-bot Local VM limit is ${input.maxInstances} — delete an unused bot VM or raise the limit in App Settings`,
    };
  }
  return { action: "create" };
}

export async function ensureLocalVm(input: {
  status: LocalVmEnsureStatus;
  lifecycleBusy: boolean;
  imageBusy: boolean;
  modeChangeBusy: boolean;
  provisionBusy: boolean;
  leaseOwnedByThisTurn: boolean;
  existingCount: number;
  maxInstances: number;
  mode: LocalVmMode;
  targetExists: boolean;
  create: () => Promise<LocalVmEnsureStatus>;
  recreate: () => Promise<LocalVmEnsureStatus>;
}): Promise<LocalVmEnsureResult> {
  const decision = decideLocalVmEnsure(input);
  if (decision.action === "ready") return { state: "ready" };
  if (decision.action === "wait") return { state: "starting", retryable: true, message: decision.message };
  if (decision.action === "blocked") return { state: "blocked", retryable: false, message: decision.message };
  const after = decision.action === "create" ? await input.create() : await input.recreate();
  if (after.ready) return { state: "ready" };
  return { state: "starting", retryable: true, message: LOCAL_VM_STARTING_MESSAGE };
}

export function isLocalVmInvokeTool(name: string): boolean {
  return LOCAL_VM_INVOKE_TOOL_SET.has(name);
}

export function sanitizeLocalVmInvokeText(text: string): string {
  let out = redactSecretsInText(text);

  // file:// URLs
  out = out.replace(/file:\/\/\S*/gi, "[redacted-local-url]");

  // Explicit URL schemes (http, https, vnc, rfb) for loopback, link-local, cloud metadata, host.docker.internal, and private IPs
  out = out.replace(/(?:https?|vnc|rfb):\/\/(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|0\.0\.0\.0|169\.254(?:\.\d{1,3}){2})(?::\d+)?\S*/gi, "[redacted-local-url]");
  out = out.replace(/(?:https?|vnc|rfb):\/\/host\.docker\.internal(?::\d+)?\S*/gi, "[redacted-local-url]");
  out = out.replace(/(?:https?|vnc|rfb):\/\/(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})(?::\d+)?\S*/gi, "[redacted-local-url]");

  // Scheme-less loopback, link-local metadata, and internal endpoints
  out = out.replace(/\b(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|169\.254(?:\.\d{1,3}){2}|\[::1\]):\d+\S*/gi, "[redacted-local-url]");
  out = out.replace(/\b169\.254\.169\.254(?:\/\S*)?\b/g, "[redacted-local-url]");
  out = out.replace(/\b127\.(?:(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){2}(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\b/g, "[redacted-local-url]");

  // Standalone host.docker.internal mentions
  out = out.replace(/\bhost\.docker\.internal\b/gi, "[redacted-host]");

  // VNC viewer HTML and auth tokens
  out = out.replace(/vnc\.html\S*/gi, "[redacted-viewer]");
  out = out.replace(/\bVNC_PW=\S+/gi, "VNC_PW=[redacted]");
  out = out.replace(/\bpassword=[^\s&#]+/gi, "password=[redacted]");

  // Bare VNC port disclosures (5900-5909, 6080-6089) in VNC/port contexts
  out = out.replace(/\b(?:port\s*[:=]?\s*)(?:590\d|608\d)\b/gi, "port [redacted-port]");
  out = out.replace(/:(?:590\d|608\d)\b/g, ":[redacted-port]");
  out = out.replace(/\b(?:vnc|rfb|novnc|viewer)\s+(?:on\s+)?(?:port\s+)?(?:590\d|608\d)\b/gi, "vnc [redacted-port]");
  out = out.replace(/\b(?:rfbport|vncport)\s*[:=]?\s*\d+\b/gi, "[redacted-port]");

  // Runtime socket paths
  out = out.replace(/\bunix:\/\/[^\s"']+\.sock\b/gi, "[redacted-socket]");
  out = out.replace(/\/(?:[^\s"']+\/)?(?:podman|docker|containerd|cua)[^\s"']*\.sock\b/gi, "[redacted-socket]");
  out = out.replace(/\/(?:var\/)?run\/user\/\d+\/[^\s"']+/g, "[redacted-path]");
  out = out.replace(/\/(?:var\/)?run\/[^\s"']+\.sock\b/gi, "[redacted-socket]");
  out = out.replace(/\/tmp\/[^\s"']+\.sock\b/gi, "[redacted-socket]");

  // Host filesystem paths (keep durable /home/cua paths visible)
  out = out.replace(/\/Users\/[^\s"'\\]+/g, "[redacted-path]");
  out = out.replace(/[A-Za-z]:\\[^\s"']+/g, "[redacted-path]");
  out = out.replace(/\/(?:private|var)\/folders\/[^\s"']+/g, "[redacted-path]");
  out = out.replace(/\/home\/(?!cua(?:\/|\b))[^\s"']+/g, "[redacted-path]");

  return out;
}

export interface LocalVmInvokeExecution {
  text: string;
  isError: boolean;
  image?: string;
}

async function cdpCall(
  runner: CommandRunner,
  runtime: Runtime,
  container: string,
  action: string,
  payload: object = {},
): Promise<string> {
  const { stdout } = await runner(
    runtime,
    browserCdpExecArgs(action, payload, { container }),
    30_000,
  );
  return stdout.trim();
}

function field(args: object, key: string): string | number | boolean | object | null {
  if (!(key in args)) return null;
  const value = (args as { [key: string]: string | number | boolean | object | null | undefined })[key];
  return value === undefined ? null : value;
}

function parseInvokeArgs(raw: object | null): object {
  return raw ?? {};
}

export async function executeLocalVmInvokeTool(
  name: string,
  rawArgs: object | null,
  ctx: { runtime: Runtime; containerName: string; runner: CommandRunner },
): Promise<LocalVmInvokeExecution> {
  if (!isLocalVmInvokeTool(name)) {
    return { text: "That computer tool is not available on this bot's Local VM.", isError: true };
  }
  const args = parseInvokeArgs(rawArgs);
  try {
    if (name === "screenshot") {
      await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "screenshot");
      const { stdout } = await ctx.runner(
        ctx.runtime,
        ["exec", ctx.containerName, "base64", "-w0", "/tmp/openmausbot-preview.jpg"],
        30_000,
      );
      const data = stdout.trim();
      if (!data) return { text: "The Local VM screenshot was empty. Retry shortly.", isError: true };
      return { text: "Captured this bot's browser.", isError: false, image: data };
    }
    if (name === "get_desktop_state") {
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "snapshot");
      return { text: sanitizeLocalVmInvokeText(out || "Inspected this bot's browser page."), isError: false };
    }
    if (name === "open_url") {
      const url = field(args, "url");
      const normalized = normalizeBrowserUrl(url);
      const publicUrl = safeBrowserUrl(url);
      if (!normalized || !publicUrl) {
        return { text: "open_url needs an http(s) URL.", isError: true };
      }
      await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "navigate", { url: normalized });
      return { text: `Opened ${publicUrl} in this bot's browser.`, isError: false };
    }
    if (name === "click") {
      const x = Number(field(args, "x"));
      const y = Number(field(args, "y"));
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { text: "click needs numeric x and y.", isError: true };
      }
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "mouse", {
        x: Math.round(x),
        y: Math.round(y),
        button: field(args, "button") === "right" ? "right" : "left",
        double: field(args, "double") === true,
      });
      return { text: sanitizeLocalVmInvokeText(out || "Clicked in this bot's browser."), isError: false };
    }
    if (name === "type_text") {
      const text = field(args, "text");
      if (typeof text !== "string" || !text) return { text: "type_text needs text.", isError: true };
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "type", { text });
      return { text: sanitizeLocalVmInvokeText(out || "Typed in this bot's browser."), isError: false };
    }
    if (name === "press_key") {
      const keysRaw = field(args, "keys");
      const keys = typeof keysRaw === "string" ? keysRaw.trim() : "";
      if (!keys) return { text: "press_key needs keys.", isError: true };
      const out = await cdpCall(ctx.runner, ctx.runtime, ctx.containerName, "key", { keys });
      return { text: sanitizeLocalVmInvokeText(out || "Pressed a key in this bot's browser."), isError: false };
    }
    if (name === "launch_app") {
      const appRaw = field(args, "app");
      const app = typeof appRaw === "string" ? appRaw.trim() : "";
      if (!app) return { text: "launch_app needs an app name.", isError: true };
      if (/chrom|browser|firefox/i.test(app)) {
        return { text: "The browser is already running. Use open_url to load a site.", isError: false };
      }
      return { text: `This computer is a browser plus shell. There is no GUI app named ${app}. Use computer_exec for CLI tools.`, isError: true };
    }
    if (name === "computer_exec") {
      const commandRaw = field(args, "command");
      const command = typeof commandRaw === "string" ? commandRaw.trim() : "";
      if (!command) return { text: "computer_exec needs a command.", isError: true };
      const trimmed = command.slice(0, 4000);
      try {
        const { stdout } = await ctx.runner(
          ctx.runtime,
          ["exec", "-u", "cua", "-w", "/home/cua/workspace", "-e", "HOME=/home/cua", ctx.containerName, "bash", "-lc", trimmed],
          120_000,
        );
        return { text: sanitizeLocalVmInvokeText(stdout || "Command finished on this bot's Local VM."), isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: sanitizeLocalVmInvokeText(message), isError: true };
      }
    }
    return { text: "That computer tool is not available on this bot's Local VM.", isError: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: sanitizeLocalVmInvokeText(message), isError: true };
  }
}
