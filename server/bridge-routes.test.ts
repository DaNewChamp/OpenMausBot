import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { handleBridgeRoutes, isBridgeAdminLoopback, type EncodedJson } from "./bridge-routes.ts";

interface RouteRequestBody {
  action?: string;
  jobId?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

function jsonReq(
  method: string,
  url: string,
  body?: RouteRequestBody,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  // SAFETY: handleBridgeRoutes only reads method, url, headers, and the async iterable body.
  return Object.assign(Readable.from([payload]), {
    method,
    url,
    headers: { "content-type": "application/json", ...headers },
  }) as IncomingMessage;
}

function capture() {
  let status = 0;
  let body: EncodedJson = {};
  const json = (_res: ServerResponse, nextStatus: number, nextBody: EncodedJson) => {
    status = nextStatus;
    body = nextBody;
  };
  return {
    json,
    result: () => ({ status, body }),
  };
}

function unusedResponse(): ServerResponse {
  // SAFETY: handleBridgeRoutes writes through the json() callback; it does not use the ServerResponse instance.
  return {} as ServerResponse;
}

describe("bridge admin loopback", () => {
  it("refuses companion-forwarded TCP loopback as admin", () => {
    const req = jsonReq("GET", "/api/bridge/jobs", undefined, { "x-openmausbot-companion": "1" });
    expect(isBridgeAdminLoopback(req, { loopback: true })).toBe(false);
    expect(isBridgeAdminLoopback(jsonReq("GET", "/api/bridge/jobs"), { loopback: true })).toBe(true);
    expect(isBridgeAdminLoopback(jsonReq("GET", "/api/bridge/jobs"), { loopback: false })).toBe(false);
  });
});

describe("bridge job audit routes", () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    for (const file of ["bridges.json", "bridge-jobs.json"]) {
      const path = join(DATA_DIR, file);
      if (existsSync(path)) rmSync(path);
    }
  });

  it("lists and cancels jobs only on harness-host loopback", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "mini", code, capabilities: ["shell"] });
    const job = registry.enqueueShell(bridgeId, "echo hi");

    const denied = capture();
    expect(
      await handleBridgeRoutes(
        jsonReq("GET", "/api/bridge/jobs", undefined, { "x-openmausbot-companion": "1" }),
        unusedResponse(),
        "GET",
        "/api/bridge/jobs",
        denied.json,
        registry,
        { loopback: true },
      ),
    ).toBe(true);
    expect(denied.result().status).toBe(403);

    const listed = capture();
    await handleBridgeRoutes(
      jsonReq("GET", `/api/bridge/jobs?bridgeId=${bridgeId}`),
      unusedResponse(),
      "GET",
      "/api/bridge/jobs",
      listed.json,
      registry,
      { loopback: true },
    );
    const jobs = listed.result().body.jobs ?? [];
    expect(listed.result().status).toBe(200);
    expect(jobs.map((entry) => entry.id)).toEqual([job.id]);

    const cancelled = capture();
    await handleBridgeRoutes(
      jsonReq("POST", `/api/bridge/jobs/${job.id}`, { action: "cancel" }),
      unusedResponse(),
      "POST",
      `/api/bridge/jobs/${job.id}`,
      cancelled.json,
      registry,
      { loopback: true },
    );
    expect(cancelled.result().status).toBe(200);
    expect(cancelled.result().body.job?.status).toBe("cancelled");
  });

  it("lets a paired companion list and revoke bridges but not audit jobs", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "mini", code, capabilities: ["shell"] });

    const listed = capture();
    await handleBridgeRoutes(
      jsonReq("GET", "/api/bridges", undefined, { "x-openmausbot-companion": "1" }),
      unusedResponse(),
      "GET",
      "/api/bridges",
      listed.json,
      registry,
      { loopback: true },
    );
    expect(listed.result().status).toBe(200);
    const bridges = listed.result().body.bridges ?? [];
    expect(bridges[0]?.id).toBe(bridgeId);
    expect(Object.hasOwn(bridges[0] ?? {}, "tokenHash")).toBe(false);

    const jobs = capture();
    await handleBridgeRoutes(
      jsonReq("GET", "/api/bridge/jobs", undefined, { "x-openmausbot-companion": "1" }),
      unusedResponse(),
      "GET",
      "/api/bridge/jobs",
      jobs.json,
      registry,
      { loopback: true },
    );
    expect(jobs.result().status).toBe(403);

    const revoked = capture();
    await handleBridgeRoutes(
      jsonReq("DELETE", `/api/bridges/${bridgeId}`, undefined, { "x-openmausbot-companion": "1" }),
      unusedResponse(),
      "DELETE",
      `/api/bridges/${bridgeId}`,
      revoked.json,
      registry,
      { loopback: true },
    );
    expect(revoked.result().status).toBe(200);
    expect(registry.list()).toEqual([]);
  });

  it("lets a paired companion rotate a bridge token", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId, bridgeToken } = registry.register({ name: "mini", code, capabilities: ["shell"] });

    const rotated = capture();
    await handleBridgeRoutes(
      jsonReq("POST", `/api/bridges/${bridgeId}/rotate`, undefined, { "x-openmausbot-companion": "1" }),
      unusedResponse(),
      "POST",
      `/api/bridges/${bridgeId}/rotate`,
      rotated.json,
      registry,
      { loopback: true },
    );
    expect(rotated.result().status).toBe(200);
    expect(registry.authorize(`Bearer ${bridgeToken}`)?.id).toBe(bridgeId);
  });

  it("does not invent jobs from unsolicited results", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeToken } = registry.register({ name: "mini", code, capabilities: ["shell"] });
    const captured = capture();
    await handleBridgeRoutes(
      jsonReq(
        "POST",
        "/api/bridge/result",
        { jobId: "ghost", exitCode: 0, stdout: "hi", stderr: "", truncated: false },
        { authorization: `Bearer ${bridgeToken}` },
      ),
      unusedResponse(),
      "POST",
      "/api/bridge/result",
      captured.json,
      registry,
      { loopback: false },
    );
    expect(captured.result().status).toBe(404);
    expect(registry.getJob("ghost")).toBeNull();
  });
});
