import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = "omb_computer_destination_token";
let harness: Server;
let sidecar: Server;
let port = 0;
let localVmAccess = false;
let granted: string[] = [];
let seen: { method: string; path: string; body: string }[] = [];

const listen = (server: Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

const device = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bot: { id: "bot-1", computer: "vm" } }));
    });
  });
  const harnessPort = await listen(harness);
  sidecar = createServer(createProxyHandler({
    harnessPort,
    authenticate: (token) => token === TOKEN ? { id: "phone-1", cloudDesktopAccess: false, localVmAccess } : null,
    redeem: () => ({ error: "not used" }),
    serverName: () => "Test computer",
    grantLocalVmAccess: (id) => {
      granted.push(id);
      localVmAccess = true;
      return true;
    },
  }));
  port = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("computer destination companion boundary", () => {
  it("rewrites onto the harness bot PATCH and grants Local VM access", async () => {
    seen = [];
    granted = [];
    localVmAccess = false;
    const switched = await device("PATCH", "/api/bots/bot-1/computer-destination", { computer: "vm" });
    expect(switched.status).toBe(200);
    expect(seen).toEqual([
      { method: "PATCH", path: "/api/bots/bot-1", body: JSON.stringify({ computer: "vm" }) },
    ]);
    expect(granted).toEqual(["phone-1"]);
    expect(localVmAccess).toBe(true);
  });

  it("refuses execution-policy fields instead of forwarding them", async () => {
    seen = [];
    const rejected = await device("PATCH", "/api/bots/bot-1/computer-destination", {
      computer: "vm",
      autoApprove: true,
    });
    expect(rejected.status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("paired model companion boundary", () => {
  it("forwards instance and model to the harness model route", async () => {
    seen = [];
    const switched = await device("PATCH", "/api/bots/bot-1/model", {
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
    expect(switched.status).toBe(200);
    expect(seen).toEqual([
      { method: "PATCH", path: "/api/bots/bot-1/model", body: JSON.stringify({ instanceId: "codex", model: "gpt-5.6-sol" }) },
    ]);
  });

  it("rewrites an effort change onto the harness bot PATCH", async () => {
    seen = [];
    const switched = await device("PATCH", "/api/bots/bot-1/model", {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(switched.status).toBe(200);
    expect(seen).toEqual([
      {
        method: "PATCH",
        path: "/api/bots/bot-1",
        body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-5.6-sol", effort: "high" } }),
      },
    ]);
  });

  it("clears effort by rewriting a modelSelection without the key", async () => {
    seen = [];
    const cleared = await device("PATCH", "/api/bots/bot-1/model", {
      instanceId: "codex",
      model: "gpt-5.6-sol",
      effort: null,
    });
    expect(cleared.status).toBe(200);
    expect(seen).toEqual([
      {
        method: "PATCH",
        path: "/api/bots/bot-1",
        body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } }),
      },
    ]);
  });
});
