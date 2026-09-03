import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { handleBridgeRoutes } from "./bridge-routes.ts";

function reset(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function jsonSink() {
  let status = 0;
  let body: unknown;
  const json = (_res: ServerResponse, nextStatus: number, nextBody: unknown) => {
    status = nextStatus;
    body = nextBody;
  };
  return {
    json,
    res: {} as ServerResponse,
    result: () => ({ status, body }),
  };
}

function request(method: string, path: string, opts?: { authorization?: string; body?: unknown }): IncomingMessage {
  const payload = opts?.body === undefined ? "" : JSON.stringify(opts.body);
  const chunks = payload ? [Buffer.from(payload)] : [];
  return {
    method,
    url: path,
    headers: {
      authorization: opts?.authorization,
      "content-type": "application/json",
    },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as IncomingMessage;
}

describe("bridge route trust boundary", () => {
  beforeEach(() => {
    reset();
  });

  it("treats companion-proxied traffic as not direct loopback", async () => {
    const registry = new BridgeRegistry();
    const sink = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/pairing"),
      sink.res,
      "POST",
      "/api/bridge/pairing",
      sink.json,
      registry,
      { direct: false, companion: true, operator: false },
    );
    expect(sink.result().status).toBe(403);

    const jobs = jsonSink();
    await handleBridgeRoutes(
      request("GET", "/api/bridge/jobs"),
      jobs.res,
      "GET",
      "/api/bridge/jobs",
      jobs.json,
      registry,
      { direct: false, companion: true, operator: false },
    );
    expect(jobs.result().status).toBe(403);
  });

  it("requires operator authorization for job audit and cancel even on direct loopback", async () => {
    const registry = new BridgeRegistry();
    const sink = jsonSink();
    await handleBridgeRoutes(
      request("GET", "/api/bridge/jobs"),
      sink.res,
      "GET",
      "/api/bridge/jobs",
      sink.json,
      registry,
      { direct: true, companion: false, operator: false },
    );
    expect(sink.result().status).toBe(403);
  });

  it("lists and revokes bridges for companion or direct host callers", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const { bridgeId } = registry.register({ name: "mini", code, capabilities: ["shell"] });

    const listed = jsonSink();
    await handleBridgeRoutes(
      request("GET", "/api/bridges"),
      listed.res,
      "GET",
      "/api/bridges",
      listed.json,
      registry,
      { direct: false, companion: true, operator: false },
    );
    expect(listed.result().status).toBe(200);
    expect(listed.result().body).toEqual({
      bridges: [expect.objectContaining({ id: bridgeId, name: "mini", capabilities: ["shell"] })],
    });

    const revoked = jsonSink();
    await handleBridgeRoutes(
      request("DELETE", `/api/bridges/${bridgeId}`),
      revoked.res,
      "DELETE",
      `/api/bridges/${bridgeId}`,
      revoked.json,
      registry,
      { direct: false, companion: true, operator: false },
    );
    expect(revoked.result()).toEqual({ status: 200, body: { ok: true, bridgeId } });
    expect(registry.list()).toEqual([]);
  });

  it("rejects unknown and foreign result posts", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const first = registry.register({ name: "a", code, capabilities: ["shell"] });
    const { code: code2 } = registry.startPairing();
    const second = registry.register({ name: "b", code: code2, capabilities: ["shell"] });
    const job = registry.enqueueShell(first.bridgeId, "echo hi");
    registry.pollJobs(first.bridgeId);

    const unknown = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/result", {
        authorization: `Bearer ${first.bridgeToken}`,
        body: { jobId: "missing", exitCode: 0, stdout: "", stderr: "", generation: 1 },
      }),
      unknown.res,
      "POST",
      "/api/bridge/result",
      unknown.json,
      registry,
      { direct: true, companion: false, operator: false },
    );
    expect(unknown.result().status).toBe(404);

    const foreign = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/result", {
        authorization: `Bearer ${second.bridgeToken}`,
        body: { jobId: job.id, exitCode: 0, stdout: "hijack", stderr: "", generation: 1 },
      }),
      foreign.res,
      "POST",
      "/api/bridge/result",
      foreign.json,
      registry,
      { direct: true, companion: false, operator: false },
    );
    expect(foreign.result().status).toBe(409);
    expect(registry.getJob(job.id)?.status).toBe("running");
  });

  it("authenticates Hermes tools with the calling bridge through the host or companion", async () => {
    const registry = new BridgeRegistry();
    const { code } = registry.startPairing();
    const first = registry.register({ name: "mini", code, capabilities: ["hermes"] });
    const { code: code2 } = registry.startPairing();
    const second = registry.register({ name: "other", code: code2, capabilities: ["hermes"] });
    const calls: Array<{ bridgeId: string; name: string; botScope: string }> = [];

    const companion = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/hermes-tools", {
        authorization: `Bearer ${first.bridgeToken}`,
        body: { name: "list_bots", botScope: "bot-chief", arguments: {} },
      }),
      companion.res,
      "POST",
      "/api/bridge/hermes-tools",
      companion.json,
      registry,
      {
        direct: false,
        companion: true,
        operator: false,
        hermesTools: async (input) => {
          calls.push(input);
          return { status: 200, body: { text: "No other bots in this section yet." } };
        },
      },
    );
    expect(companion.result()).toEqual({
      status: 200,
      body: { text: "No other bots in this section yet." },
    });
    expect(calls).toEqual([{ bridgeId: first.bridgeId, name: "list_bots", botScope: "bot-chief", args: {} }]);

    const unauthorized = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/hermes-tools", {
        authorization: "Bearer not-a-bridge",
        body: { name: "list_bots", botScope: "bot-chief", arguments: {} },
      }),
      unauthorized.res,
      "POST",
      "/api/bridge/hermes-tools",
      unauthorized.json,
      registry,
      {
        direct: true,
        companion: false,
        operator: false,
        hermesTools: async () => ({ status: 200, body: { text: "should-not-run" } }),
      },
    );
    expect(unauthorized.result().status).toBe(401);

    const missingScope = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/hermes-tools", {
        authorization: `Bearer ${first.bridgeToken}`,
        body: { name: "list_bots", arguments: {} },
      }),
      missingScope.res,
      "POST",
      "/api/bridge/hermes-tools",
      missingScope.json,
      registry,
      {
        direct: true,
        companion: false,
        operator: false,
        hermesTools: async (input) => {
          calls.push(input);
          return { status: 200, body: { text: "ok" } };
        },
      },
    );
    expect(missingScope.result().status).toBe(400);
    expect(calls).toHaveLength(1);

    const permitted = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/hermes-tools", {
        authorization: `Bearer ${first.bridgeToken}`,
        body: { name: "list_bots", botScope: "bot-chief", arguments: {} },
      }),
      permitted.res,
      "POST",
      "/api/bridge/hermes-tools",
      permitted.json,
      registry,
      {
        direct: true,
        companion: false,
        operator: false,
        hermesTools: async (input) => {
          calls.push(input);
          return { status: 200, body: { text: "No other bots in this section yet." } };
        },
      },
    );
    expect(permitted.result()).toEqual({
      status: 200,
      body: { text: "No other bots in this section yet." },
    });
    expect(calls).toEqual([
      { bridgeId: first.bridgeId, name: "list_bots", botScope: "bot-chief", args: {} },
      { bridgeId: first.bridgeId, name: "list_bots", botScope: "bot-chief", args: {} },
    ]);
    expect(JSON.stringify(permitted.result().body)).not.toMatch(/bridgeToken|Bearer|OMB_COMMS/i);

    const otherBridge = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/hermes-tools", {
        authorization: `Bearer ${second.bridgeToken}`,
        body: { name: "list_bots", botScope: "bot-chief", arguments: {} },
      }),
      otherBridge.res,
      "POST",
      "/api/bridge/hermes-tools",
      otherBridge.json,
      registry,
      {
        direct: true,
        companion: false,
        operator: false,
        hermesTools: async (input) => {
          calls.push(input);
          return { status: 403, body: { error: "Bot is out of scope for this bridge", code: "bot_scope", isError: true } };
        },
      },
    );
    expect(otherBridge.result().status).toBe(403);
    expect(calls[2]?.bridgeId).toBe(second.bridgeId);
  });
});
