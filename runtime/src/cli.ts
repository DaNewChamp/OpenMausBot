import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";

import {
  createFileEnvelopeSecretStore,
  type HostSecretStore,
} from "../../server/host-secret-store.ts";
import {
  loadOrCreateHubIdentity,
  ensurePrivateDataDir,
} from "../../shared/hub-identity.mjs";
import {
  createControlPlaneClient,
  normalizeControlPlaneURL,
} from "../../shared/control-plane-client.mjs";
import {
  assertHostSecretStoreAvailable,
  createHubAccountService,
} from "./hub-account.ts";

const DEFAULT_CONTROL_PLANE_URL = "https://accounts.openmausbot.com";
const DEFAULT_APP_VERSION = "0.1.37";
const MAX_OTP_INPUT_BYTES = 64;
const SAFE_ERROR_CODES = new Set([
  "invalid_email",
  "invalid_otp",
  "invalid_request",
  "invalid_response",
  "invalid_client_identity",
  "signed_out",
  "unauthorized",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "conflict",
  "request_too_large",
  "unsupported_media_type",
  "rate_limited",
  "otp_expired",
  "credential_rotation_rate_limited",
  "installation_limit_reached",
  "installation_exists",
  "endpoint_busy",
  "endpoint_unavailable",
  "endpoint_cleanup_pending",
  "internal_error",
  "control_plane_unavailable",
  "network_unavailable",
  "request_failed",
]);

type Output = { write(chunk: string): unknown };
type Input = AsyncIterable<unknown>;

interface HubIdentity {
  schemaVersion: 1;
  id: string;
  createdAt: number;
}

interface HubAccountService {
  requestCode(email: string): Promise<unknown>;
  verifyCode(email: string, otp: string): Promise<unknown>;
  register(): Promise<unknown>;
  heartbeat(): Promise<void>;
  fleet(): Promise<unknown>;
  stopPresence(): void;
  dispose?: () => Promise<void>;
  signOut(): Promise<void>;
}

export interface VbotctlDependencies {
  stdin?: Input | string;
  stdout?: Output;
  stderr?: Output;
  prompt?: (question: string, options?: { hideEchoBack?: boolean }) => Promise<string>;
  service?: HubAccountService;
  client?: ReturnType<typeof createControlPlaneClient>;
  identity?: HubIdentity;
  secrets?: HostSecretStore;
  createService?: (options: {
    client: ReturnType<typeof createControlPlaneClient>;
    identity: HubIdentity;
    profile: "headless-hub";
    platform: "darwin" | "windows" | "linux";
    appVersion: string;
    displayName: string;
    secrets: HostSecretStore;
    now?: () => number;
  }) => HubAccountService;
  createClient?: (options: { baseURL: string }) => unknown;
  createSecretStore?: (options: { dataDir: string }) => unknown;
  readIdentity?: (options: { dataDir: string }) => unknown;
  controlPlaneURL?: string;
  environment?: Record<string, string | undefined>;
  platform?: string;
  appVersion?: string;
  now?: () => number;
}

type ParsedCommand =
  | { dataDir: string; kind: "request-code"; email: string }
  | { dataDir: string; kind: "verify-code"; email: string; fromStdin: boolean }
  | { dataDir: string; kind: "register"; name: string }
  | { dataDir: string; kind: "heartbeat" }
  | { dataDir: string; kind: "fleet" }
  | { dataDir: string; kind: "sign-out" };

class UsageError extends Error {}

function usageError(message = "invalid command"): UsageError {
  return new UsageError(message);
}

function writeLine(target: Output, value: string): void {
  target.write(`${value}\n`);
}

function parseFlagValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  let occurrences = 0;
  let inlineValue: string | undefined;
  let separateIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) {
      occurrences += 1;
      if (occurrences === 1) inlineValue = value.slice(prefix.length);
      continue;
    }
    if (value === name) {
      occurrences += 1;
      if (occurrences === 1) separateIndex = index;
    }
  }
  if (occurrences > 1) throw usageError(`duplicate ${name}`);
  if (occurrences === 0) return undefined;
  if (separateIndex >= 0) {
    if (separateIndex + 1 >= args.length || args[separateIndex + 1].startsWith("--")) {
      throw usageError(`missing ${name}`);
    }
    return args[separateIndex + 1];
  }
  return inlineValue;
}

function removeFlag(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) {
      index += 1;
      continue;
    }
    if (value.startsWith(`${name}=`)) continue;
    result.push(value);
  }
  return result;
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  const args = [...argv];
  let dataDir: string | undefined;
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--data-dir") {
      if (dataDir !== undefined || index + 1 >= args.length || args[index + 1].startsWith("--")) {
        throw usageError("missing --data-dir");
      }
      dataDir = args[++index];
      continue;
    }
    if (value.startsWith("--data-dir=")) {
      if (dataDir !== undefined) throw usageError("duplicate --data-dir");
      dataDir = value.slice("--data-dir=".length);
      continue;
    }
    commandArgs.push(value);
  }
  if (!dataDir || !isAbsolute(dataDir)) throw usageError("an absolute --data-dir is required");

  const [group, action, ...rest] = commandArgs;
  if (group === "account" && action === "request-code") {
    const email = parseFlagValue(rest, "--email");
    const remaining = removeFlag(rest, "--email");
    if (!email || remaining.length > 0) throw usageError("account request-code requires --email");
    return { dataDir, kind: "request-code", email };
  }
  if (group === "account" && action === "verify-code") {
    const email = parseFlagValue(rest, "--email");
    const stdinCount = rest.filter((value) => value === "--stdin").length;
    if (stdinCount > 1) throw usageError("duplicate --stdin");
    const fromStdin = stdinCount === 1;
    const remaining = removeFlag(removeFlag(rest, "--email"), "--stdin");
    if (!email || remaining.length > 0) throw usageError("account verify-code requires --email");
    return { dataDir, kind: "verify-code", email, fromStdin };
  }
  if (group === "account" && action === "sign-out") {
    if (rest.length > 0) throw usageError("account sign-out takes no arguments");
    return { dataDir, kind: "sign-out" };
  }
  if (group === "hub" && action === "register") {
    const name = parseFlagValue(rest, "--name");
    const remaining = removeFlag(rest, "--name");
    if (!name || name.trim().length === 0 || remaining.length > 0) {
      throw usageError("hub register requires --name");
    }
    return { dataDir, kind: "register", name };
  }
  if (group === "hub" && action === "heartbeat") {
    if (rest.length !== 1 || rest[0] !== "--once") throw usageError("hub heartbeat requires --once");
    return { dataDir, kind: "heartbeat" };
  }
  if (group === "fleet" && action === "list") {
    if (rest.length !== 1 || rest[0] !== "--json") throw usageError("fleet list requires --json");
    return { dataDir, kind: "fleet" };
  }
  throw usageError("unknown command");
}

function redactOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOutput);
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|credential|secret|password|key)$/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactOutput(item);
    }
  }
  return output;
}

function boundedOtpInput(value: unknown): string {
  if (typeof value !== "string") throw usageError("verification code is required");
  if (Buffer.byteLength(value, "utf8") > MAX_OTP_INPUT_BYTES) {
    throw usageError("verification code is too long");
  }
  const trimmed = value.trim();
  if (!trimmed) throw usageError("verification code is required");
  return trimmed;
}

async function readStdin(input: Input | string): Promise<string> {
  if (typeof input === "string") return boundedOtpInput(input);
  const chunks: string[] = [];
  let bytes = 0;
  if (input && typeof input[Symbol.asyncIterator] === "function") {
    for await (const chunk of input) {
      let text: string;
      try {
        text = typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8");
      } catch {
        throw usageError("verification code is required");
      }
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > MAX_OTP_INPUT_BYTES) throw usageError("verification code is too long");
      chunks.push(text);
    }
  }
  return boundedOtpInput(chunks.join(""));
}

async function hiddenPrompt(dependencies: VbotctlDependencies): Promise<string> {
  if (dependencies.prompt) {
    return boundedOtpInput(await dependencies.prompt("Verification code: ", { hideEchoBack: true }));
  }
  if (processStdin.isTTY !== true || typeof processStdin.setRawMode !== "function") {
    throw usageError("verification code requires --stdin");
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const input = processStdin;
    const promptOutput = dependencies.stderr ?? processStderr;
    const restore = () => {
      input.off("data", onData);
      input.off("error", onError);
      try {
        input.setRawMode?.(false);
      } catch {
        // The original operation result remains authoritative.
      }
      input.pause();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      restore();
      if (error) reject(error);
      else {
        try {
          resolve(boundedOtpInput(value));
        } catch (validationError) {
          reject(validationError);
        }
      }
    };
    const onError = () => finish(usageError("verification code input failed"));
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(usageError("verification code cancelled"));
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if ((character.codePointAt(0) ?? 0) < 0x20) {
          finish(usageError("verification code input failed"));
          return;
        }
        if (Buffer.byteLength(value + character, "utf8") > MAX_OTP_INPUT_BYTES) {
          finish(usageError("verification code is too long"));
          return;
        }
        value += character;
      }
    };
    input.on("data", onData);
    input.once("error", onError);
    try {
      input.setRawMode(true);
      input.resume();
      promptOutput.write("Verification code: ");
    } catch {
      finish(usageError("verification code input failed"));
    }
  });
}

function resolveControlPlaneURL(dependencies: VbotctlDependencies): string {
  const environment = dependencies.environment ?? process.env;
  const configured = dependencies.controlPlaneURL ?? environment.OMB_CONTROL_PLANE_URL;
  if (configured !== undefined) {
    const normalized = normalizeControlPlaneURL(configured);
    if (!normalized) throw new Error("invalid control plane URL");
    return normalized;
  }
  return DEFAULT_CONTROL_PLANE_URL;
}

function defaultPlatform(value: string | undefined): "darwin" | "windows" | "linux" {
  if (value === "win32") return "windows";
  if (value === "darwin" || value === "windows" || value === "linux") return value;
  throw new Error("invalid wire platform");
}

function safeFailure(error: unknown): string {
  if (error instanceof UsageError) return error.message;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (SAFE_ERROR_CODES.has(code)) return code;
  }
  return "command failed";
}

async function createServiceForCommand(command: ParsedCommand, dependencies: VbotctlDependencies): Promise<HubAccountService> {
  if (dependencies.service) return dependencies.service;
  // Validate the explicit runtime directory before touching identity or
  // secret state. The helper narrows existing modes and rejects symlinks,
  // files, ownership mismatches, and races.
  ensurePrivateDataDir(command.dataDir);
  const secrets = dependencies.secrets ?? (dependencies.createSecretStore
    ? dependencies.createSecretStore({ dataDir: command.dataDir }) as HostSecretStore
    : createFileEnvelopeSecretStore({ dataDir: command.dataDir }));
  assertHostSecretStoreAvailable(secrets);
  const identity = dependencies.identity ?? (dependencies.readIdentity
    ? dependencies.readIdentity({ dataDir: command.dataDir }) as HubIdentity
    : loadOrCreateHubIdentity({
      dataDir: command.dataDir,
      beforePublish: () => assertHostSecretStoreAvailable(secrets),
    }));
  const client = dependencies.client ?? (dependencies.createClient
    ? dependencies.createClient({ baseURL: resolveControlPlaneURL(dependencies) }) as ReturnType<typeof createControlPlaneClient>
    : createControlPlaneClient({ baseURL: resolveControlPlaneURL(dependencies) }));
  const displayName = command.kind === "register" ? command.name : "Headless Hub";
  const platform = defaultPlatform(dependencies.platform ?? process.platform);
  const appVersion = dependencies.appVersion ?? process.env.npm_package_version ?? DEFAULT_APP_VERSION;
  const factory = dependencies.createService ?? createHubAccountService;
  return factory({
    client,
    identity,
    profile: "headless-hub",
    platform,
    appVersion,
    displayName,
    secrets,
    now: dependencies.now,
  });
}

async function outputResult(target: Output, value: unknown): Promise<void> {
  writeLine(target, JSON.stringify(redactOutput(value)));
}

export async function runVbotctl(argv: readonly string[] = process.argv.slice(2), dependencies: VbotctlDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? processStdout;
  const stderr = dependencies.stderr ?? processStderr;
  let command: ParsedCommand;
  try {
    command = parseArguments(argv);
  } catch (error) {
    writeLine(stderr, `Usage error: ${safeFailure(error)}`);
    return 2;
  }

  let service: HubAccountService;
  try {
    service = await createServiceForCommand(command, dependencies);
  } catch (error) {
    writeLine(stderr, safeFailure(error));
    return 1;
  }

  let exitCode = 0;
  try {
    switch (command.kind) {
      case "request-code":
        await outputResult(stdout, await service.requestCode(command.email));
        break;
      case "verify-code": {
        const code = command.fromStdin
          ? await readStdin(dependencies.stdin ?? processStdin)
          : await hiddenPrompt(dependencies);
        if (!code) throw new Error("verification code is required");
        await outputResult(stdout, await service.verifyCode(command.email, code));
        break;
      }
      case "register":
        await outputResult(stdout, await service.register());
        break;
      case "heartbeat":
        await service.heartbeat();
        await outputResult(stdout, { ok: true });
        break;
      case "fleet":
        await outputResult(stdout, await service.fleet());
        break;
      case "sign-out":
        await service.signOut();
        await outputResult(stdout, { ok: true });
        break;
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  } catch (error) {
    writeLine(stderr, safeFailure(error));
    exitCode = 1;
  } finally {
    try {
      if (service.dispose) await service.dispose();
    } catch {
      if (exitCode === 0) {
        writeLine(stderr, "command failed");
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runVbotctl().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
