import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";
import {
  mintViewerAccessToken,
  resetViewerAccessTickets,
  verifyViewerAccessToken,
  VIEWER_ACCESS_COOKIE,
} from "../src/viewer-access.ts";

const TOKEN = "omb_local_vm_test_token";
const DEVICE_ID = "phone-1";
let harness: Server;
let sidecar: Server;
let port = 0;
let localVmAccess = false;
let seen: { path: string; marker: string }[] = [];

const listen = (server: Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

const device = async (
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  extraHeaders: Record<string, string> = {},
) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(contentType ? { "content-type": contentType } : body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* html */ }
  return { status: response.status, body: parsed, text, headers: response.headers };
};

beforeAll(async () => {
  resetViewerAccessTickets();
  harness = createServer((req, res) => {
    const url = req.url ?? "";
    seen.push({ path: url, marker: String(req.headers["x-openmausbot-companion"] ?? "") });
    req.resume();
    req.on("end", () => {
      if (url.startsWith("/api/bots/bot-1/local-computer/join")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          viewerPath: "/api/bots/bot-1/local-computer/viewer/vnc.html#autoconnect=true",
          ready: true,
        }));
        return;
      }
      if (url.includes("/local-computer/viewer")) {
        expect(url).not.toContain("omb_viewer");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body>noVNC fixture</body></html>");
        return;
      }
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
    authenticate: (token) => token === TOKEN ? { id: DEVICE_ID, cloudDesktopAccess: false, localVmAccess } : null,
    redeem: () => ({ error: "not used" }),
    serverName: () => "Test computer",
    deviceById: (id) => id === DEVICE_ID ? { id: DEVICE_ID, cloudDesktopAccess: false, localVmAccess } : null,
  }));
  port = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

describe("Local VM companion boundary", () => {
  it("denies status, lifecycle, join, input, and viewer by default", async () => {
    seen = [];
    expect((await device("GET", "/api/bots/bot-1/local-computer")).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/run", {})).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/stop", {})).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/recreate", {})).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/screenshot", {})).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/join", {})).status).toBe(403);
    expect((await device("POST", "/api/bots/bot-1/local-computer/input", { action: "click", x: 1, y: 1, button: "left" })).status).toBe(403);
    expect((await device("GET", "/api/bots/bot-1/local-computer/viewer/vnc.html")).status).toBe(403);
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
    expect((await device("POST", "/api/bots/bot-1/local-computer/screenshot", { image: true })).status).toBe(400);
    expect(seen).toHaveLength(2);
    expect((await device("POST", "/api/bots/bot-1/local-computer/screenshot", {})).status).toBe(200);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ path: "/api/bots/bot-1/local-computer/screenshot", marker: "1" });
    expect((await device("POST", "/api/bots/bot-1/local-computer/remove", {})).status).toBe(403);
    localVmAccess = false;
  });

  it("mints a one-time viewer ticket and invalidates the prior join", async () => {
    localVmAccess = true;
    const first = await device("POST", "/api/bots/bot-1/local-computer/join", {});
    expect(first.status).toBe(200);
    const firstPath = String(first.body?.viewerPath ?? "");
    expect(firstPath).toContain("omb_viewer=");
    expect(firstPath).toContain("#autoconnect=true");
    const firstTicket = new URL(firstPath, "http://127.0.0.1").searchParams.get("omb_viewer");
    expect(firstTicket).toBeTruthy();
    expect(verifyViewerAccessToken(firstTicket!, "bot-1")).toBe(DEVICE_ID);

    const html = await device("GET", firstPath.split("#")[0] ?? firstPath);
    expect(html.status).toBe(200);
    expect(html.text).toContain("noVNC fixture");
    const cookie = html.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${VIEWER_ACCESS_COOKIE}=`);

    const viaCookie = await fetch(`http://127.0.0.1:${port}/api/bots/bot-1/local-computer/viewer/vnc.html`, {
      headers: { cookie: `${VIEWER_ACCESS_COOKIE}=${encodeURIComponent(firstTicket!)}` },
    });
    expect(viaCookie.status).toBe(200);

    const expired = mintViewerAccessToken(DEVICE_ID, "bot-1", Date.now() - 40 * 60_000);
    const stale = await fetch(
      `http://127.0.0.1:${port}/api/bots/bot-1/local-computer/viewer/vnc.html?omb_viewer=${encodeURIComponent(expired)}`,
    );
    expect(stale.status).toBe(401);

    const second = await device("POST", "/api/bots/bot-1/local-computer/join", {});
    expect(second.status).toBe(200);
    const secondTicket = new URL(String(second.body?.viewerPath ?? ""), "http://127.0.0.1").searchParams.get("omb_viewer");
    expect(secondTicket).toBeTruthy();
    expect(secondTicket).not.toBe(firstTicket);

    const staleFirst = await fetch(
      `http://127.0.0.1:${port}/api/bots/bot-1/local-computer/viewer/vnc.html?omb_viewer=${encodeURIComponent(firstTicket!)}`,
    );
    expect(staleFirst.status).toBe(401);

    const fresh = await fetch(
      `http://127.0.0.1:${port}/api/bots/bot-1/local-computer/viewer/vnc.html?omb_viewer=${encodeURIComponent(secondTicket!)}`,
    );
    expect(fresh.status).toBe(200);

    const viaSecondCookie = await fetch(`http://127.0.0.1:${port}/api/bots/bot-1/local-computer/viewer/vnc.html`, {
      headers: { cookie: `${VIEWER_ACCESS_COOKIE}=${encodeURIComponent(secondTicket!)}` },
    });
    expect(viaSecondCookie.status).toBe(200);
    localVmAccess = false;
  });
});
