import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { BridgeRegistry } from "./bridge-registry.ts";
import { handleBridgeRoutes } from "./bridge-routes.ts";
import { encodeFleetChatResult, parseFleetModelId } from "../shared/bridge-fleet-contract.ts";
import {
  advertisedFleetInstances,
  dispatchFleetModelTurn,
  ingestLocalModelCatalog,
  lastKnownLocalModelsFor,
  listAdvertisedFleetModels,
  lookupFleetModel,
  resetFleetModelCatalogForTests,
  sendFleetChatOnBridge,
  unloadFleetModelCatalogForTests,
} from "./bridge-fleet-models.ts";
import { HermesBridgeUnavailableError } from "./bridge-hermes.ts";
import { HermesEngineError } from "./engines/contracts.ts";
import type { RuntimeEvent } from "./contracts.ts";

function resetBridgeData(): void {
  resetFleetModelCatalogForTests();
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const file of ["bridges.json", "bridge-jobs.json", "fleet-models.json"]) {
    const path = join(DATA_DIR, file);
    if (existsSync(path)) rmSync(path);
  }
}

function pairedBridge(name = "Mac mini") {
  const registry = new BridgeRegistry();
  const { code } = registry.startPairing();
  const { bridgeId, bridgeToken } = registry.register({ name, code, capabilities: ["shell"] });
  registry.touch(bridgeId);
  return { registry, bridgeId, bridgeToken };
}

const catalog = {
  kind: "local-models" as const,
  servers: [{
    kind: "ollama" as const,
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [{ id: "llama3.2", name: "Llama 3.2" }, { id: "qwen2.5:7b", name: "Qwen 2.5" }],
  }],
};

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

describe("fleet model id", () => {
  it("parses machineSlug/modelId including slashes in the model id", () => {
    expect(parseFleetModelId("fleet/mac-mini/llama3.2")).toEqual({
      machineSlug: "mac-mini",
      modelId: "llama3.2",
    });
    expect(parseFleetModelId("fleet/mac-mini/lmstudio-community/Meta-Llama-3.1")).toEqual({
      machineSlug: "mac-mini",
      modelId: "lmstudio-community/Meta-Llama-3.1",
    });
    expect(parseFleetModelId("claude-sonnet")).toBeNull();
  });
});

describe("hub ingest and GET /api/fleet-models", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("stores last-known catalogs per bridge and builds the API body", () => {
    expect(ingestLocalModelCatalog("bridge-mini", catalog, { name: "Mac mini", now: 1_000 })).toEqual(catalog);
    expect(lastKnownLocalModelsFor("bridge-mini")?.slug).toBe("mac-mini");
    expect(listAdvertisedFleetModels({ now: 1_000 })).toEqual([
      {
        id: "fleet/mac-mini/llama3.2",
        machine: "Mac mini",
        label: "Llama 3.2",
        server: "ollama",
        models: [{ id: "llama3.2", name: "Llama 3.2" }],
      },
      {
        id: "fleet/mac-mini/qwen2.5:7b",
        machine: "Mac mini",
        label: "Qwen 2.5",
        server: "ollama",
        models: [{ id: "qwen2.5:7b", name: "Qwen 2.5" }],
      },
    ]);
    expect(advertisedFleetInstances({ now: 1_000 })).toEqual([
      {
        instanceId: "fleet/mac-mini",
        driverKind: "fleet",
        displayName: "Mac mini",
        snapshot: { state: "available", version: "ollama" },
        models: {
          default: "fleet/mac-mini/llama3.2",
          options: [
            { id: "fleet/mac-mini/llama3.2", label: "Llama 3.2" },
            { id: "fleet/mac-mini/qwen2.5:7b", label: "Qwen 2.5" },
          ],
        },
        capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false },
      },
    ]);
  });

  it("keeps last-known across restart and forgets after 2x the discovery interval", () => {
    ingestLocalModelCatalog("bridge-mini", catalog, { name: "Mac mini", now: 10_000, intervalMs: 60_000 });
    unloadFleetModelCatalogForTests();
    expect(listAdvertisedFleetModels({ now: 11_000 })).toHaveLength(2);
    expect(listAdvertisedFleetModels({ now: 10_000 + 120_001 })).toEqual([]);
  });

  it("ingests the heartbeat payload the same way Hermes descriptors are shipped", async () => {
    const { registry, bridgeId, bridgeToken } = pairedBridge();
    const sink = jsonSink();
    await handleBridgeRoutes(
      request("POST", "/api/bridge/heartbeat", {
        authorization: `Bearer ${bridgeToken}`,
        body: { bridgeId, localModels: catalog },
      }),
      sink.res,
      "POST",
      "/api/bridge/heartbeat",
      sink.json,
      registry,
      { direct: true, companion: false, operator: true },
    );
    expect(sink.result().status).toBe(200);
    expect(listAdvertisedFleetModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fleet/mac-mini/llama3.2", machine: "Mac mini", server: "ollama" }),
    ]));
  });

  it("ignores a malformed payload and keeps the previous catalog", () => {
    ingestLocalModelCatalog("bridge-mini", catalog, { name: "Mac mini", now: 1_000 });
    expect(ingestLocalModelCatalog("bridge-mini", { kind: "nope" }, { name: "Mac mini", now: 2_000 })).toEqual(catalog);
    expect(listAdvertisedFleetModels({ now: 2_000 })).toHaveLength(2);
  });
});

describe("fleet turn routing", () => {
  beforeEach(() => {
    resetBridgeData();
  });

  it("enqueues a fleet-chat bridge job and replays scrubbed events", async () => {
    vi.useFakeTimers();
    const { registry, bridgeId } = pairedBridge();
    ingestLocalModelCatalog(bridgeId, catalog, { name: "Mac mini", now: Date.now() });
    const published: RuntimeEvent[] = [];
    const promise = dispatchFleetModelTurn({
      registry,
      model: "fleet/mac-mini/llama3.2",
      messages: [{ role: "user", content: "hi" }],
      threadId: "thread-1",
      turnId: "turn-1",
      publishEvent: (event) => published.push(event),
      instanceId: "fleet",
    });
    await vi.advanceTimersByTimeAsync(500);
    const [job] = registry.pollJobs(bridgeId);
    expect(job?.kind).toBe("fleet-chat");
    expect(job && "payload" in job ? job.payload : null).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    registry.storeResult({
      jobId: job!.id,
      bridgeId,
      exitCode: 0,
      stdout: encodeFleetChatResult({
        kind: "fleet-chat",
        body: {
          ok: true,
          turnId: "turn-1",
          events: [{
            eventId: "evt-1",
            provider: "fleet",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: "2026-09-01T00:00:00.000Z",
            type: "content.delta",
            streamKind: "assistant_text",
            delta: "Hello",
          }, {
            eventId: "evt-2",
            provider: "fleet",
            threadId: "thread-1",
            turnId: "turn-1",
            createdAt: "2026-09-01T00:00:01.000Z",
            type: "turn.completed",
            ok: true,
          }],
        },
      }),
      stderr: "",
      truncated: false,
      finishedAt: Date.now(),
      generation: job!.generation,
    });
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(published.map((event) => event.type)).toEqual(["content.delta", "turn.completed"]);
    expect(published[0]).toMatchObject({ delta: "Hello", providerInstanceId: "fleet" });
    vi.useRealTimers();
  });

  it("fails closed with HermesEngineError when the bridge is offline", async () => {
    ingestLocalModelCatalog("missing-bridge", catalog, { name: "Mac mini", now: Date.now() });
    const registry = new BridgeRegistry();
    await expect(dispatchFleetModelTurn({
      registry,
      model: "fleet/mac-mini/llama3.2",
      messages: [{ role: "user", content: "hi" }],
      threadId: "thread-1",
      turnId: "turn-1",
      publishEvent: () => {},
    })).rejects.toBeInstanceOf(HermesEngineError);
    await expect(sendFleetChatOnBridge(registry, {
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
      threadId: "thread-1",
      turnId: "turn-1",
    })).rejects.toBeInstanceOf(HermesBridgeUnavailableError);
  });

  it("looks up an advertised fleet model by id", () => {
    ingestLocalModelCatalog("bridge-mini", catalog, { name: "Mac mini", now: 1_000 });
    expect(lookupFleetModel("fleet/mac-mini/llama3.2", { now: 1_000 })).toMatchObject({
      bridgeId: "bridge-mini",
      modelId: "llama3.2",
      server: expect.objectContaining({ kind: "ollama" }),
    });
    expect(lookupFleetModel("fleet/mac-mini/missing", { now: 1_000 })).toBeNull();
  });
});
