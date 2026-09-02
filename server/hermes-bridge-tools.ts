import { resolveBotRuntimeBinding } from "./bot-runtime-binding.ts";
import { AGENT_PROXY_TOOL_NAMES, executeAgentsProxyTool } from "./drivers/agents-proxy.ts";
import { redactSecretsInText } from "./redact.ts";
import { sectionKey, type Store } from "./store.ts";

const HERMES_BRIDGE_ALLOWED_TOOLS = [
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

export const HERMES_BRIDGE_TOOLS_PATH = "/api/bridge/hermes-tools";

const TARGET_BOT_ARG_TOOLS = new Set([
  "ask_bot",
  "delegate_bot",
  "configure_bot",
  "configure_bot_runtime",
]);

export type HermesBridgeToolScopeFailure = {
  ok: false;
  code: "unknown_tool" | "bot_scope" | "state_unavailable";
  message: string;
};

export type HermesBridgeToolScopeSuccess = {
  ok: true;
  botId: string;
};

export type HermesBridgeToolScopeResult = HermesBridgeToolScopeSuccess | HermesBridgeToolScopeFailure;

export function hermesBridgeToolsPath(): string {
  return HERMES_BRIDGE_TOOLS_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publicScopeError(code: HermesBridgeToolScopeFailure["code"], message: string): HermesBridgeToolScopeFailure {
  return { ok: false, code, message: redactSecretsInText(message) };
}

function botBoundToBridge(store: Store, botId: string, bridgeId: string): boolean {
  const bot = store.bot(botId);
  if (!bot) return false;
  const resolved = resolveBotRuntimeBinding(bot);
  if (resolved.state !== "available") return false;
  const binding = resolved.value;
  return (
    binding.kind === "hermes"
    && binding.placement.kind === "bridge"
    && binding.placement.bridgeId === bridgeId
  );
}

export function evaluateHermesBridgeToolScope(input: {
  store: Store;
  bridgeId: string;
  botScope: string;
  name: string;
  args: Record<string, unknown>;
}): HermesBridgeToolScopeResult {
  if (
    !(HERMES_BRIDGE_ALLOWED_TOOLS as readonly string[]).includes(input.name)
    || !AGENT_PROXY_TOOL_NAMES.includes(input.name)
  ) {
    return publicScopeError("unknown_tool", "Unknown tool");
  }
  const botScope = input.botScope.trim();
  if (!botScope || !botBoundToBridge(input.store, botScope, input.bridgeId)) {
    return publicScopeError("bot_scope", "Bot is out of scope for this bridge");
  }
  const actor = input.store.bot(botScope);
  if (!actor) return publicScopeError("bot_scope", "Bot is out of scope for this bridge");

  if (TARGET_BOT_ARG_TOOLS.has(input.name)) {
    const targetId = typeof input.args.bot_id === "string" ? input.args.bot_id.trim() : "";
    if (targetId && targetId !== botScope) {
      const target = input.store.bot(targetId);
      if (!target || target.hidden || sectionKey(target.section) !== sectionKey(actor.section)) {
        return publicScopeError("bot_scope", "Bot is out of scope for this bridge");
      }
    }
  }
  return { ok: true, botId: botScope };
}

export function parseHermesBridgeToolRequest(body: unknown): {
  name: string;
  args: Record<string, unknown>;
  botScope: string;
} | { error: string } {
  if (!isRecord(body)) return { error: "invalid tool request" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const botScope = typeof body.botScope === "string" ? body.botScope.trim() : "";
  const args = isRecord(body.arguments) ? body.arguments : {};
  if (!name) return { error: "name required" };
  if (!botScope) return { error: "botScope required" };
  return { name, args, botScope };
}

export async function executeHermesBridgeTool(input: {
  store: Store;
  bridgeId: string;
  name: string;
  args: Record<string, unknown>;
  botScope: string;
  comms: { url: string; token: string };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const scoped = evaluateHermesBridgeToolScope(input);
  if (!scoped.ok) {
    const status = scoped.code === "unknown_tool" ? 400 : 403;
    return { status, body: { error: scoped.message, code: scoped.code, isError: true } };
  }
  const actor = input.store.bot(scoped.botId);
  try {
    const result = await executeAgentsProxyTool(input.name, input.args, {
      harnessUrl: input.comms.url,
      token: input.comms.token,
      botId: scoped.botId,
      threadId: actor?.threadId ?? "",
      turnDepth: 0,
    });
    const text = redactSecretsInText(result.text);
    return {
      status: 200,
      body: result.isError ? { text, isError: true } : { text },
    };
  } catch (error) {
    const message = redactSecretsInText(error instanceof Error ? error.message : "tool execution failed");
    return { status: 200, body: { text: message, isError: true } };
  }
}
