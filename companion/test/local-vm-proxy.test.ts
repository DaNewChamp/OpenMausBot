import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = "omb_local_vm_test_token";
let harness: Server;
let sidecar: Server;
let port = 0;
let localVmAccess = false;
let seen: { path: string; marker: string }[] = [];

const listen = (server: Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

const device = async (method: string, path: string, body?: unknown, contentType?: string) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(contentType ? { "content-type": contentType } : body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    seen.push({ path: req.url ?? "", marker: String(req.headers["x-openmausbot-companion"] ?? "") });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        mode: "per-bot",
        max_instances: 2,
        state: "ready",
        container: "running",
        daemon_up: true,
        image_ready: true,
        desktop_ready: true,
        ready: true,
        create_supported: true,
        busy: false,
        can_create: false,
        can_stop: true,
        can_recreate: true,
        problem: null,
      }));
    });
  });
  const harnessPort = await listen(harness);
  sidecar = createServer(createProxyHandler({
    harnessPort,
    authenticate: (token) => token === TOKEN ? { cloudDesktopAccess: false, localVmAccess } : null,
    redeem: () => ({ error: "not used" }),
    serverName: () => "Test computer",
  }));
  port = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("Local VM companion boundary", () => {
  it("denies status and lifecycle by default", async () => {
    seen = [];
    expect((await device("GET", "/api/bots/bot-1/local-computer")).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/run", {})).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("forwards only safe status and empty-body actions when enabled", async () => {
    localVmAccess = true;
    seen = [];
    const status = await device("GET", "/api/bots/bot-1/local-computer");
    expect(status.status).toBe(200);
    expect(status.body).toHaveProperty("state", "ready");
    expect(seen[0]).toMatchObject({ path: "/api/bots/bot-1/local-computer", marker: "1" });

    expect((await device("POST", "/api/bots/bot-1/local-computer/run", { command: "unsafe" })).status).toBe(400);
    expect(seen).toHaveLength(1);
    expect((await device("POST", "/api/bots/bot-1/local-computer/run", "unsafe")).status).toBe(400);
    expect(seen).toHaveLength(1);
    expect((await device("POST", "/api/bots/bot-1/local-computer/run", undefined, "application/json")).status).toBe(400);
    expect(seen).toHaveLength(1);
    expect((await device("POST", "/api/bots/bot-1/local-computer/run", {})).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect((await device("POST", "/api/bots/bot-1/local-computer/remove", {})).status).toBe(403);
    localVmAccess = false;
  });
});
