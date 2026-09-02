import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import { writeFileAtomic } from "../../server/atomic.ts";
import { connectHermesVbotConnector, type JsonRpcRequest, type JsonRpcSuccess } from "./hermes-vbot-connector.ts";

const SECRETISH = /token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i;

export function mcpFacadeArgv(input: { socketPath: string; botScope: string }): string[] {
  return ["--socket", input.socketPath, "--bot-scope", input.botScope];
}

export function parseMcpFacadeArgv(argv: string[]): { socketPath: string; botScope: string } {
  if (argv.some((arg) => /token|OMB_COMMS|Bearer/i.test(arg))) {
    throw new Error("Hermes MCP facade argv must not include hub credentials");
  }
  const socketIndex = argv.indexOf("--socket");
  const scopeIndex = argv.indexOf("--bot-scope");
  const socketPath = socketIndex >= 0 ? argv[socketIndex + 1] : undefined;
  const botScope = scopeIndex >= 0 ? argv[scopeIndex + 1] : undefined;
  if (!socketPath || !botScope) {
    throw new Error("usage: vbot-hermes-mcp --socket <path> --bot-scope <bot-id>");
  }
  return { socketPath, botScope };
}

export function formatMcpLog(line: string): string {
  return line
    .replace(/\b(?:token|secret|password|authorization)=[^\s]+/gi, (match) => `${match.split("=")[0]}=[redacted]`)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/HERMES_HOME(?:=[^\s]*)?/gi, "HERMES_HOME")
    .replace(/(?:\/[\w.-]+)+/g, "[path]");
}

export const HERMES_VBOT_ALLOWED_TOOLS = [
  "list_bots",
  "ask_bot",
  "delegate_bot",
  "create_bot",
  "configure_bot",
  "configure_bot_runtime",
  "run_on_bridge",
  "run_on_ssh_target",
  "list_rooms",
  "create_room",
  "update_room",
  "list_routines",
  "create_routine",
  "run_routine",
  "request_credential",
  "skills_list",
  "skill_view",
  "skill_manage",
] as const;

export function createHermesVbotDaemonHandler(): (request: JsonRpcRequest) => Promise<JsonRpcSuccess> {
  return async (request) => {
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "vbot-hermes-mcp", version: "0.1.0" },
        },
      };
    }
    if (request.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: HERMES_VBOT_ALLOWED_TOOLS.map((name) => ({ name })) },
      };
    }
    if (request.method === "ping") {
      return { jsonrpc: "2.0", id: request.id, result: {} };
    }
    return { jsonrpc: "2.0", id: request.id, result: { ok: false, message: "tool unavailable" } };
  };
}

export function hermesVbotMcpLaunchSpec(input: {
  cliPath: string;
  socketPath: string;
  botScope: string;
  execPath?: string;
  execArgv?: string[];
}): { command: string; args: string[] } {
  const facade = mcpFacadeArgv({ socketPath: input.socketPath, botScope: input.botScope });
  return {
    command: input.execPath ?? process.execPath,
    args: [...(input.execArgv ?? process.execArgv), input.cliPath, "hermes-mcp", ...facade],
  };
}

export function peerCredentialFromBridgeIdentity(credentialsPath: string): string {
  const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as { bridgeId?: unknown };
  if (typeof parsed.bridgeId !== "string" || parsed.bridgeId.length === 0) {
    throw new Error("bridge identity is unavailable");
  }
  if (SECRETISH.test(parsed.bridgeId)) {
    throw new Error("refusing to use secret-shaped bridge identity");
  }
  return parsed.bridgeId;
}

export function parseInstalledHermesVbotConnector(configPath: string): { socketPath: string; botScope: string } | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, { args?: unknown }>;
    };
    const args = parsed.mcpServers?.vbot?.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return null;
    return parseMcpFacadeArgv(args as string[]);
  } catch {
    return null;
  }
}

export function installHermesVbotConnector(input: {
  configPath: string;
  socketPath: string;
  botScope: string;
  hubDisplayName: string;
  command?: string;
  args?: string[];
  cliPath?: string;
}): { adopted: boolean; configPath: string } {
  mkdirSync(dirname(input.configPath), { recursive: true, mode: 0o700 });
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(input.configPath)) {
    try {
      existing = JSON.parse(readFileSync(input.configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    } catch {
      existing = {};
    }
  }
  const existingEntry = existing.mcpServers?.vbot as { metadata?: { profile?: string } } | undefined;
  const adopted = Boolean(existingEntry?.metadata?.profile === "vbot");
  if (input.args) {
    parseMcpFacadeArgv(input.args);
    if (input.args.some((arg) => SECRETISH.test(arg))) {
      throw new Error("refusing to write secret-shaped Hermes connector metadata");
    }
  }
  const launch = input.command && input.args
    ? { command: input.command, args: input.args }
    : hermesVbotMcpLaunchSpec({
      cliPath: input.cliPath ?? fileURLToPath(new URL("./index.js", import.meta.url)),
      socketPath: input.socketPath,
      botScope: input.botScope,
    });
  parseMcpFacadeArgv(launch.args);
  if (launch.args.some((arg) => SECRETISH.test(arg)) || SECRETISH.test(launch.command)) {
    throw new Error("refusing to write secret-shaped Hermes connector metadata");
  }
  const next = {
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      vbot: {
        command: launch.command,
        args: launch.args,
        metadata: {
          hub: input.hubDisplayName,
          profile: "vbot",
        },
      },
    },
  };
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (SECRETISH.test(serialized)) {
    throw new Error("refusing to write secret-shaped Hermes connector metadata");
  }
  writeFileAtomic(input.configPath, serialized, { mode: 0o600 });
  return { adopted, configPath: input.configPath };
}

export async function runHermesVbotMcpStdio(input: {
  argv: string[];
  credentialsPath: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): Promise<void> {
  const parsed = parseMcpFacadeArgv(input.argv);
  const peerCredential = peerCredentialFromBridgeIdentity(input.credentialsPath);
  const client = await connectHermesVbotConnector({
    socketPath: parsed.socketPath,
    peerCredential,
    botScope: parsed.botScope,
  });
  const stdout = input.stdout ?? process.stdout;
  const rl = readline.createInterface({ input: input.stdin ?? process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: string | number; method?: string; params?: unknown };
    try {
      msg = JSON.parse(trimmed) as { id?: string | number; method?: string; params?: unknown };
    } catch {
      return;
    }
    if (!msg.method) return;
    void client.request(msg.method, msg.params).then((result: unknown) => {
      if (msg.id === undefined) return;
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
    }).catch((error: unknown) => {
      if (msg.id === undefined) return;
      stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: error instanceof Error ? error.message : "request failed" },
      })}\n`);
    });
  });
  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      client.close();
      resolve();
    });
  });
}
