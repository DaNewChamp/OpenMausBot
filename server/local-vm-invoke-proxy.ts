// Static MCP surface for a bot's own Local VM when the desktop is not yet
// ready. tools/list is available at turn start; the first tools/call asks
// the harness to ensure the VM, then runs the bounded computer action.
// The proxy never talks to host CUA, VNC, or an arbitrary host terminal.
import readline from "node:readline";

import { CONTROL_REFUSAL_PLAIN, createControlClient } from "./control-client.ts";
import { LOCAL_VM_INVOKE_TOOLS, isLocalVmInvokeTool } from "./local-vm-invoke.ts";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";

const control = createControlClient();

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (id: unknown, text: string, isError = false, image?: string) => {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (image) content.push({ type: "image", mimeType: "image/png", data: image });
  ok(id, { content, isError });
};

async function invoke(name: string, args: Json): Promise<Json> {
  const res = await fetch(`${HARNESS}/api/internal/local-vm/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      botId: BOT_ID,
      threadId: THREAD_ID,
      tool: name,
      arguments: args,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-local-vm", version: "1" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: LOCAL_VM_INVOKE_TOOLS });
      return;
    case "tools/call": {
      const name = String(params.name ?? "");
      if (!isLocalVmInvokeTool(name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const held = control.configured ? (await control.state(true)).held : false;
        if (held) {
          toolResult(id, CONTROL_REFUSAL_PLAIN, true);
          return;
        }
        const rawArgs = params.arguments;
        const args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Json) : {};
        const body = await invoke(name, args);
        if (body.state === "starting") {
          toolResult(
            id,
            JSON.stringify({
              state: "starting",
              retryable: true,
              message: String(body.message ?? "The Local VM is starting. Retry this computer action shortly."),
            }),
            false,
          );
          return;
        }
        if (body.state === "blocked") {
          toolResult(id, String(body.message ?? "The Local VM is unavailable."), true);
          return;
        }
        const result = (body.result ?? {}) as { text?: string; isError?: boolean; image?: string };
        toolResult(id, String(result.text ?? "Done on this bot's Local VM."), result.isError === true, result.image);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolResult(id, message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((error) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (error as Error).message);
  });
});
rl.on("close", () => process.exit(0));
