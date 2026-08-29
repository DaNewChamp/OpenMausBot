import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { handleBridgeRoutes, isBridgeAdminLoopback } from "./bridge-routes.ts";

function jsonReq(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from([payload]), {
    method,
    url,
    headers: { "content-type": "application/json", ...headers },
  }) as IncomingMessage;
}

function capture() {
  let status = 0;
  let body: unknown;
  const json = (_res: ServerResponse, nextStatus: number, nextBody: unknown) => {
    status = nextStatus;
    body = nextBody;
  };
  return {
    json,
    result: () => ({ status, body: body as Record<string, unknown> }),
  };
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
        {} as ServerResponse,
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
      {} as ServerResponse,
      "GET",
      "/api/bridge/jobs",
      listed.json,
      registry,
      { loopback: true },
    );
    const jobs = listed.result().body.jobs as Array<{ id: string }>;
    expect(listed.result().status).toBe(200);
    expect(jobs.map((entry) => entry.id)).toEqual([job.id]);

    const cancelled = capture();
    await handleBridgeRoutes(
      jsonReq("POST", `/api/bridge/jobs/${job.id}`, { action: "cancel" }),
      {} as ServerResponse,
      "POST",
      `/api/bridge/jobs/${job.id}`,
      cancelled.json,
      registry,
      { loopback: true },
    );
    expect(cancelled.result().status).toBe(200);
    expect((cancelled.result().body.job as { status: string }).status).toBe("cancelled");
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
      {} as ServerResponse,
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
