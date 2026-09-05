import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";

const token = "fixture-control-device";
const route = "/api/bots/bot-one/local-computer/control";
let harness: Server, sidecar: Server, port: number;
let enabled = false;
let seen: { path: string; body: string }[] = [];
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const request = async (method: string, path = route, body?: unknown, type = "application/json", paired = true) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": type, ...(paired ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.text(); return response.status;
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => { seen.push({ path: req.url ?? "", body }); res.writeHead(200, { "content-type": "application/json" }); res.end('{"held":false}'); });
  });
  const harnessPort = await listen(harness);
  sidecar = createServer(createProxyHandler({
    harnessPort, authenticate: input => input === token ? { id: "fixture-device", cloudDesktopAccess: false, localVmAccess: enabled } : null,
    redeem: () => ({ error: "not used" }), serverName: () => "Fixture",
  }));
  port = await listen(sidecar);
});
afterAll(async () => { await close(sidecar); await close(harness); });

describe("Local VM control HTTP boundary", () => {
  it("requires both pairing and the Local VM capability", async () => {
    enabled = false; seen = [];
    expect(await request("GET")).toBe(403);
    expect(await request("POST", route, { action: "take" })).toBe(403);
    expect(await request("GET", route, undefined, "application/json", false)).toBe(401);
    expect(seen).toEqual([]);
  });
  it("rejects broader operations before forwarding", async () => {
    enabled = true; seen = [];
    expect(await request("POST", route, { action: "take", extra: true })).toBe(400);
    expect(await request("POST", route, { action: "take" }, "application/jsonp")).toBe(415);
    expect(await request("GET", route + "?botId=other")).toBe(400);
    expect(await request("POST", route, { action: "execute" })).toBe(400);
    expect(await request("GET", "/api/bots/bot-one/computer/control")).toBe(404);
    expect(seen).toEqual([]);
  });
  it("forwards only the scoped read and exact three action objects", async () => {
    enabled = true; seen = [];
    expect(await request("GET")).toBe(200);
    for (const action of ["take", "release", "dismiss-help"]) {
      expect(await request("POST", route, { action })).toBe(200);
    }
    expect(seen.map(row => row.path)).toEqual([route, route, route, route]);
    expect(seen.map(row => row.body)).toEqual(["", '{"action":"take"}', '{"action":"release"}', '{"action":"dismiss-help"}']);
  });
});
