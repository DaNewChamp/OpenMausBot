import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { writeFileAtomic } from "../../server/atomic.ts";
import { connectHermesVbotConnector, type JsonRpcRequest, type JsonRpcSuccess } from "./hermes-vbot-connector.ts";

const SECRETISH = /token|OMB_COMMS|Bearer|sk-|HERMES_HOME/i;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const LEGACY_MCP_PROFILE = "vbot";

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

export type HermesVbotToolResult = { text: string; isError?: boolean };
export type HermesVbotToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<HermesVbotToolResult>;

export type PairedHermesHarnessCredentials =
  | { state: "available"; url: string; secret: string }
  | { state: "unavailable"; code: "state_unavailable" };

export type HermesDaemonCredentialSnapshot =
  | { state: "available"; url: string; loopback: true }
  | { state: "unavailable"; code: "state_unavailable" };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mcpTextResult(id: string | number, text: string, isError = false): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError },
  };
}

export async function hermesVbotToolDescriptors() {
  const { AGENT_PROXY_TOOLS } = await import("../../server/drivers/agents-proxy.ts");
  return HERMES_VBOT_ALLOWED_TOOLS.map((name) => {
    const tool = AGENT_PROXY_TOOLS.find((entry) => entry.name === name);
    if (!tool || typeof tool.description !== "string" || !tool.inputSchema) {
      throw new Error(`Hermes MCP tool metadata is unavailable for ${name}`);
    }
    return tool;
  });
}

export function pairedHermesHarnessCredentials(input: unknown): PairedHermesHarnessCredentials {
  if (!isRecord(input)) return { state: "unavailable", code: "state_unavailable" };
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const secret = typeof input.bridgeToken === "string" ? input.bridgeToken.trim() : "";
  if (!url || !secret) return { state: "unavailable", code: "state_unavailable" };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { state: "unavailable", code: "state_unavailable" };
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { state: "unavailable", code: "state_unavailable" };
    }
  } catch {
    return { state: "unavailable", code: "state_unavailable" };
  }
  return { state: "available", url, secret };
}

export function hermesDaemonCredentialSnapshot(
  credentials: PairedHermesHarnessCredentials,
): HermesDaemonCredentialSnapshot {
  if (credentials.state !== "available") {
    return { state: "unavailable", code: "state_unavailable" };
  }
  return { state: "available", url: credentials.url, loopback: true };
}

export function createHermesVbotEnvToolExecutor(
  env: NodeJS.ProcessEnv = process.env,
): HermesVbotToolExecutor {
  const scope = Object.freeze({
    harnessUrl: (env.OMB_HARNESS_URL ?? "").trim(),
    token: (env.OMB_COMMS_TOKEN ?? "").trim(),
    botId: (env.OMB_BOT_ID ?? "").trim(),
    threadId: (env.OMB_THREAD_ID ?? "").trim(),
    turnDepth: Number(env.OMB_TURN_DEPTH ?? "0") || 0,
  });
  return async (name, args) => {
    if (!scope.harnessUrl || !scope.token) {
      return { text: "V Bot tool facade is unconfigured", isError: true };
    }
    const { executeAgentsProxyTool } = await import("../../server/drivers/agents-proxy.ts");
    return await executeAgentsProxyTool(name, args, { ...scope });
  };
}

export function createHermesVbotPairedToolExecutor(
  credentials: PairedHermesHarnessCredentials,
  options?: { botScope?: string },
): HermesVbotToolExecutor {
  if (credentials.state !== "available") {
    return async () => ({ text: "V Bot tool facade is unavailable", isError: true });
  }
  const botScope = (options?.botScope ?? "").trim();
  const url = `${credentials.url.replace(/\/$/, "")}/api/bridge/hermes-tools`;
  const secret = credentials.secret;
  return async (name, args) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ name, arguments: args, botScope }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        text?: unknown;
        error?: unknown;
        isError?: unknown;
      };
      const text = typeof body.text === "string"
        ? body.text
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`;
      if (!response.ok || body.isError === true) return { text, isError: true };
      return { text };
    } catch {
      return { text: "V Bot tool facade is unavailable", isError: true };
    }
  };
}

export function createHermesDaemonToolExecutor(input: unknown): HermesVbotToolExecutor {
  const botScope = isRecord(input) && typeof input.botScope === "string" ? input.botScope.trim() : "";
  return createHermesVbotPairedToolExecutor(pairedHermesHarnessCredentials(input), { botScope });
}

export function createHermesVbotDaemonHandler(options?: {
  executeTool?: HermesVbotToolExecutor;
}): (request: JsonRpcRequest) => Promise<JsonRpcSuccess> {
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
        result: { tools: await hermesVbotToolDescriptors() },
      };
    }
    if (request.method === "ping" || request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
      return { jsonrpc: "2.0", id: request.id, result: {} };
    }
    if (request.method === "tools/call") {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (!(HERMES_VBOT_ALLOWED_TOOLS as readonly string[]).includes(name)) {
        return mcpTextResult(request.id, `Unknown tool: ${name}`, true);
      }
      if (!options?.executeTool) {
        return mcpTextResult(request.id, "V Bot tool facade is unconfigured", true);
      }
      try {
        const result = await options.executeTool(name, args);
        return mcpTextResult(request.id, result.text, result.isError === true);
      } catch (error) {
        const message = error instanceof Error ? error.message : "tool execution failed";
        return mcpTextResult(request.id, message, true);
      }
    }
    return mcpTextResult(request.id, `Method not found: ${request.method}`, true);
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

export function hermesProfileHome(profile: string, rootHome = join(homedir(), ".hermes")): string {
  const slug = normalizeProfile(profile);
  if (slug === "default") return rootHome;
  return join(rootHome, "profiles", slug);
}

export function hermesProfileConfigPath(hermesHome: string): string {
  return join(hermesHome, "config.yaml");
}

export type HermesVbotProfileConfig =
  | { state: "available"; socketPath: string; botScope: string }
  | { state: "unavailable"; code: "state_unavailable" }
  | { state: "empty" };

export type HermesVbotConnectorBinding = {
  profile: string;
  botScope: string;
  socketPath: string;
};

export type HermesVbotConnectorRegistration =
  | {
    state: "available";
    socketPath: string;
    botScopes: string[];
    bindings: HermesVbotConnectorBinding[];
  }
  | { state: "unavailable"; code: "state_unavailable" }
  | { state: "empty" };

function normalizeProfile(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slug) return "default";
  if (!PROFILE_PATTERN.test(slug) || SECRETISH.test(slug)) {
    throw new Error("Hermes profile is unavailable");
  }
  return slug;
}

function unavailable(): { state: "unavailable"; code: "state_unavailable" } {
  return { state: "unavailable", code: "state_unavailable" };
}

function stringArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== "string")) return null;
  return value as string[];
}

function bindingFromArgs(args: string[] | null, profile: string): HermesVbotConnectorBinding | null {
  if (!args) return null;
  try {
    const parsed = parseMcpFacadeArgv(args);
    return { profile, botScope: parsed.botScope, socketPath: parsed.socketPath };
  } catch {
    return null;
  }
}

function inferredSidecarProfile(metadata: unknown): string {
  if (!isRecord(metadata) || typeof metadata.profile !== "string") return "default";
  const slug = metadata.profile.trim().toLowerCase();
  if (!slug || slug === LEGACY_MCP_PROFILE) return "default";
  if (!PROFILE_PATTERN.test(slug) || SECRETISH.test(slug)) return "default";
  return slug;
}

type YamlMappingRead =
  | { state: "available"; value: Record<string, unknown> }
  | { state: "unavailable"; code: "state_unavailable" }
  | { state: "empty" };

function readYamlMapping(configPath: string): YamlMappingRead {
  try {
    if (!existsSync(configPath)) return { state: "empty" };
    if (!statSync(configPath).isFile()) return unavailable();
    const text = readFileSync(configPath, "utf8");
    if (!text.trim()) return { state: "empty" };
    const parsed = parseYaml(text);
    if (!isRecord(parsed)) return unavailable();
    return { state: "available", value: parsed };
  } catch {
    return unavailable();
  }
}

export function readHermesVbotProfileConfig(configPath: string): HermesVbotProfileConfig {
  const mapping = readYamlMapping(configPath);
  if (mapping.state !== "available") return mapping;
  const servers = mapping.value.mcp_servers;
  if (servers === undefined) return { state: "empty" };
  if (!isRecord(servers)) return unavailable();
  const entry = servers.vbot;
  if (entry === undefined) return { state: "empty" };
  if (!isRecord(entry)) return unavailable();
  const binding = bindingFromArgs(stringArgs(entry.args), "default");
  if (!binding) return unavailable();
  return { state: "available", socketPath: binding.socketPath, botScope: binding.botScope };
}

function parseSidecarBindings(parsed: Record<string, unknown>): HermesVbotConnectorBinding[] | null {
  if (parsed.bindings !== undefined) {
    if (!Array.isArray(parsed.bindings)) return null;
    const bindings: HermesVbotConnectorBinding[] = [];
    for (const row of parsed.bindings) {
      if (!isRecord(row) || typeof row.profile !== "string" || typeof row.botScope !== "string" || typeof row.socketPath !== "string") {
        return null;
      }
      if (!row.profile.trim() || !row.botScope.trim() || !row.socketPath.trim()) return null;
      if (SECRETISH.test(row.profile) || SECRETISH.test(row.botScope) || SECRETISH.test(row.socketPath)) return null;
      bindings.push({
        profile: inferredSidecarProfile({ profile: row.profile }),
        botScope: row.botScope,
        socketPath: row.socketPath,
      });
    }
    return bindings;
  }
  const args = isRecord(parsed.mcpServers)
    ? stringArgs((parsed.mcpServers.vbot as { args?: unknown } | undefined)?.args)
    : null;
  const metadata = isRecord(parsed.mcpServers)
    ? (parsed.mcpServers.vbot as { metadata?: unknown } | undefined)?.metadata
    : undefined;
  const binding = bindingFromArgs(args, inferredSidecarProfile(metadata));
  return binding ? [binding] : [];
}

export function loadHermesVbotConnectorRegistration(configPath: string): HermesVbotConnectorRegistration {
  if (!existsSync(configPath)) return { state: "empty" };
  try {
    if (!statSync(configPath).isFile()) return unavailable();
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return unavailable();
    const bindings = parseSidecarBindings(parsed);
    if (!bindings) return unavailable();
    if (bindings.length === 0) return { state: "empty" };
    const botScopes = [...new Set(bindings.map((binding) => binding.botScope))];
    return {
      state: "available",
      socketPath: bindings[0]!.socketPath,
      botScopes,
      bindings,
    };
  } catch {
    return unavailable();
  }
}

export function parseInstalledHermesVbotConnector(configPath: string): {
  socketPath: string;
  botScope: string;
  allowedBotScopes?: string[];
} | null {
  const loaded = loadHermesVbotConnectorRegistration(configPath);
  if (loaded.state !== "available") return null;
  return {
    socketPath: loaded.socketPath,
    botScope: loaded.botScopes[0]!,
    allowedBotScopes: loaded.botScopes,
  };
}

function assertWritableLaunch(command: string, args: string[]): void {
  parseMcpFacadeArgv(args);
  if (args.some((arg) => SECRETISH.test(arg)) || SECRETISH.test(command)) {
    throw new Error("refusing to write secret-shaped Hermes connector metadata");
  }
}

function rejectScopeConflict(bindings: HermesVbotConnectorBinding[], profile: string, botScope: string): void {
  for (const binding of bindings) {
    if (binding.profile === profile && binding.botScope !== botScope) {
      throw new Error("Hermes profile is already bound to another bot scope");
    }
    if (binding.botScope === botScope && binding.profile !== profile) {
      throw new Error("bot is already bound to another Hermes profile");
    }
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
  hermesHome?: string;
  profile?: string;
}): { adopted: boolean; configPath: string; hermesConfigPath?: string } {
  const profile = normalizeProfile(input.profile ?? "default");
  if (SECRETISH.test(input.hubDisplayName) || SECRETISH.test(input.socketPath) || SECRETISH.test(input.botScope)) {
    throw new Error("refusing to write secret-shaped Hermes connector metadata");
  }
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
  assertWritableLaunch(launch.command, launch.args);

  const sidecarExists = existsSync(input.configPath);
  let existingSidecar: Record<string, unknown> = {};
  let existingBindings: HermesVbotConnectorBinding[] = [];
  if (sidecarExists) {
    const loaded = loadHermesVbotConnectorRegistration(input.configPath);
    if (loaded.state === "unavailable") {
      throw new Error("Hermes connector registration is unavailable");
    }
    try {
      const parsed = JSON.parse(readFileSync(input.configPath, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("Hermes connector registration is unavailable");
      existingSidecar = parsed;
    } catch {
      throw new Error("Hermes connector registration is unavailable");
    }
    existingBindings = loaded.state === "available" ? loaded.bindings : [];
  }

  let yamlDoc: Record<string, unknown> | undefined;
  let hermesConfigPath: string | undefined;
  if (input.hermesHome) {
    try {
      if (!existsSync(input.hermesHome) || !statSync(input.hermesHome).isDirectory()) {
        throw new Error("Hermes profile is unavailable");
      }
    } catch (error) {
      if (error instanceof Error && /unavailable/i.test(error.message)) throw error;
      throw new Error("Hermes profile is unavailable");
    }
    hermesConfigPath = hermesProfileConfigPath(input.hermesHome);
    const mapping = readYamlMapping(hermesConfigPath);
    if (mapping.state === "unavailable") {
      throw new Error("Hermes profile is unavailable");
    }
    yamlDoc = mapping.state === "available" ? { ...mapping.value } : {};
    const servers = yamlDoc.mcp_servers;
    if (servers !== undefined && !isRecord(servers)) {
      throw new Error("Hermes profile is unavailable");
    }
    const existingVbot = isRecord(servers) ? servers.vbot : undefined;
    if (existingVbot !== undefined) {
      if (!isRecord(existingVbot)) throw new Error("Hermes profile is unavailable");
      const yamlBinding = bindingFromArgs(stringArgs(existingVbot.args), profile);
      if (!yamlBinding) throw new Error("Hermes profile is unavailable");
      if (yamlBinding.botScope !== input.botScope) {
        throw new Error("Hermes profile is already bound to another bot scope");
      }
    }
  }

  rejectScopeConflict(existingBindings, profile, input.botScope);
  const existingVbot = isRecord(existingSidecar.mcpServers) ? existingSidecar.mcpServers.vbot : undefined;
  const adopted = Boolean(
    isRecord(existingVbot)
    && isRecord(existingVbot.metadata)
    && existingBindings.some((binding) => binding.profile === profile && binding.botScope === input.botScope),
  );

  const nextBindings = [
    ...existingBindings.filter((binding) => binding.profile !== profile),
    { profile, botScope: input.botScope, socketPath: input.socketPath },
  ];

  if (yamlDoc && hermesConfigPath) {
    const servers = isRecord(yamlDoc.mcp_servers) ? { ...yamlDoc.mcp_servers } : {};
    servers.vbot = {
      command: launch.command,
      args: launch.args,
    };
    const nextYaml = { ...yamlDoc, mcp_servers: servers };
    const serializedYaml = stringifyYaml(nextYaml, { indent: 2 }).trimEnd() + "\n";
    if (SECRETISH.test(serializedYaml) || "mcpServers" in nextYaml) {
      throw new Error("refusing to write secret-shaped Hermes connector metadata");
    }
    writeFileAtomic(hermesConfigPath, serializedYaml, { mode: 0o600 });
  }

  mkdirSync(dirname(input.configPath), { recursive: true, mode: 0o700 });
  const nextSidecar = {
    ...existingSidecar,
    mcpServers: {
      ...(isRecord(existingSidecar.mcpServers) ? existingSidecar.mcpServers : {}),
      vbot: {
        command: launch.command,
        args: launch.args,
        metadata: {
          hub: input.hubDisplayName,
          profile,
        },
      },
    },
    bindings: nextBindings,
  };
  const serialized = `${JSON.stringify(nextSidecar, null, 2)}\n`;
  if (SECRETISH.test(serialized)) {
    throw new Error("refusing to write secret-shaped Hermes connector metadata");
  }
  writeFileAtomic(input.configPath, serialized, { mode: 0o600 });
  return { adopted, configPath: input.configPath, hermesConfigPath };
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
  const inFlight = new Set<Promise<void>>();
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
    const request = client.request(msg.method, msg.params).then((result: unknown) => {
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
    inFlight.add(request);
    void request.finally(() => inFlight.delete(request));
  });
  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      void Promise.allSettled(inFlight).finally(() => {
        client.close();
        resolve();
      });
    });
  });
}
