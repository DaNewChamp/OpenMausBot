import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_VM_INVOKE_TOOL_NAMES } from "./local-vm-invoke.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "local-vm-invoke-proxy.ts");
const TOKEN = "test-local-vm-invoke-token";

let stub: Server;
let stubPort = 0;
let child: ChildProcess;
let lastAuth: string | undefined;
let lastInvoke: { tool?: string; arguments?: unknown; botId?: string; threadId?: string } | null = null;
let invokeResponse: unknown = { state: "ready", result: { text: "clicked", isError: false } };
let createCalls = 0;

const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "POST" && req.url === "/api/internal/local-vm/invoke") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        lastInvoke = JSON.parse(data || "{}");
        createCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(invokeResponse));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-vm",
      OMB_THREAD_ID: "thread-vm",
      OMB_COMMS_TOKEN: TOKEN,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout!.on("data", (chunk) => {
    buf += chunk;
    let newline: number;
    while ((newline = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, newline);
      buf = buf.slice(newline + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("Local VM invoke MCP", () => {
  it("lists the static computer surface before the VM is started", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toBe("openmausbot-local-vm");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...LOCAL_VM_INVOKE_TOOL_NAMES]);
    expect(createCalls).toBe(0);
  });

  it("ensures the VM on the first computer tool call and returns a retryable starting state with retry guidance", async () => {
    invokeResponse = {
      state: "starting",
      retryable: true,
      message: "The Local VM desktop is still starting. Retry the exact same computer action shortly. Do not control the user's Mac.",
    };
    const res = await callTool("open_url", { url: "https://google.com" });
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastInvoke).toMatchObject({
      botId: "bot-vm",
      threadId: "thread-vm",
      tool: "open_url",
      arguments: { url: "https://google.com" },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload).toMatchObject({
      state: "starting",
      retryable: true,
      message: expect.stringContaining("Retry the exact same computer action"),
      retry: expect.stringContaining("Retry the exact same tool call"),
    });
    expect(res.result.isError).toBe(false);
  });

  it("proves subsequent ready call executes open_url", async () => {
    invokeResponse = {
      state: "ready",
      result: {
        text: "Opened https://google.com in this bot's Local VM browser.",
        isError: false,
      },
    };
    const res = await callTool("open_url", { url: "https://google.com" });
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastInvoke).toMatchObject({
      botId: "bot-vm",
      threadId: "thread-vm",
      tool: "open_url",
      arguments: { url: "https://google.com" },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toBe("Opened https://google.com in this bot's Local VM browser.");
  });

  it("refuses host-terminal tools instead of forwarding them", async () => {
    const before = createCalls;
    const res = await rpc("tools/call", { name: "computer_exec", arguments: { command: "id" } });
    expect(res.error.message).toMatch(/Unknown tool/);
    expect(createCalls).toBe(before);
  });
});
