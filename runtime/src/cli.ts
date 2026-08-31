import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";

import {
  createFileEnvelopeSecretStore,
  type HostSecretStore,
} from "../../server/host-secret-store.ts";
import {
  loadOrCreateHubIdentity,
} from "../../shared/hub-identity.mjs";
import {
  createControlPlaneClient,
  normalizeControlPlaneURL,
} from "../../shared/control-plane-client.mjs";
import {
  createHubAccountService,
} from "./hub-account.ts";

const DEFAULT_CONTROL_PLANE_URL = "https://accounts.openmausbot.com";
const DEFAULT_APP_VERSION = "0.1.37";

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
  const inline = args.filter((value) => value.startsWith(prefix));
  const separate = args.filter((value, index) => value === name && index + 1 < args.length);
  if (inline.length + separate.length > 1) throw usageError(`duplicate ${name}`);
  if (inline.length === 1) return inline[0].slice(prefix.length);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw usageError(`missing ${name}`);
  return args[index + 1];
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
    const fromStdin = rest.includes("--stdin");
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

async function readStdin(input: Input | string): Promise<string> {
  if (typeof input === "string") return input.trim();
  const chunks: string[] = [];
  if (input && typeof input[Symbol.asyncIterator] === "function") {
    for await (const chunk of input) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
  }
  return chunks.join("").trim();
}

async function hiddenPrompt(dependencies: VbotctlDependencies): Promise<string> {
  if (dependencies.prompt) return (await dependencies.prompt("Verification code: ", { hideEchoBack: true })).trim();
  const line = createInterface({ input: processStdin, output: processStderr, terminal: true });
  try {
    return (await line.question("Verification code: ", { hideEchoBack: true } as never)).trim();
  } finally {
    line.close();
  }
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
    if (/^[a-z][a-z0-9_.-]{0,63}$/.test(code)) return code;
  }
  return "command failed";
}

async function createServiceForCommand(command: ParsedCommand, dependencies: VbotctlDependencies): Promise<HubAccountService> {
  if (dependencies.service) return dependencies.service;
  const identity = dependencies.identity ?? (dependencies.readIdentity
    ? dependencies.readIdentity({ dataDir: command.dataDir }) as HubIdentity
    : loadOrCreateHubIdentity({ dataDir: command.dataDir }));
  const secrets = dependencies.secrets ?? (dependencies.createSecretStore
    ? dependencies.createSecretStore({ dataDir: command.dataDir }) as HostSecretStore
    : createFileEnvelopeSecretStore({ dataDir: command.dataDir }));
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
