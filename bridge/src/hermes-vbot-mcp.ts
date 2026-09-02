import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "../../server/atomic.ts";

const SECRETISH = /token|OMB_COMMS|Bearer|sk-|HERMES_HOME|\/Users\//i;

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

export function installHermesVbotConnector(input: {
  configPath: string;
  socketPath: string;
  botScope: string;
  hubDisplayName: string;
  command?: string;
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
  const next = {
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      vbot: {
        command: input.command ?? "vbot-hermes-mcp",
        args: mcpFacadeArgv({ socketPath: input.socketPath, botScope: input.botScope }),
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
