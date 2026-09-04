import { createServer, type AddressInfo } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { parseFleetChatResult } from "../../shared/bridge-fleet-contract.ts";
import {
  discoverLocalModelCatalog,
  discoveryEndpoints,
  modelDiscoveryIntervalMs,
  runFleetChatJob,
  shareLocalModels,
} from "./local-models.ts";

function listen(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
    server.on("error", reject);
  });
}

describe("local model discovery", () => {
  afterEach(() => {
    delete process.env.BRIDGE_SHARE_MODELS;
    delete process.env.BRIDGE_MODEL_DISCOVERY;
    delete process.env.BRIDGE_MODEL_ENDPOINTS;
  });

  it("is opt-in and disabled when BRIDGE_MODEL_DISCOVERY=off", () => {
    expect(shareLocalModels({})).toBe(false);
    expect(shareLocalModels({ BRIDGE_SHARE_MODELS: "true" })).toBe(true);
    expect(modelDiscoveryIntervalMs({})).toBe(60_000);
    expect(modelDiscoveryIntervalMs({ BRIDGE_MODEL_DISCOVERY: "off" })).toBeNull();
    expect(modelDiscoveryIntervalMs({ BRIDGE_MODEL_DISCOVERY: "30" })).toBe(30_000);
  });

  it("probes ollama, lmstudio, and extra loopback endpoints", () => {
    const endpoints = discoveryEndpoints({
      BRIDGE_MODEL_ENDPOINTS: "http://127.0.0.1:8080/v1, http://example.com/v1, not-a-url",
    });
    expect(endpoints.map((row) => row.baseUrl)).toEqual([
      "http://127.0.0.1:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://127.0.0.1:8080/v1",
    ]);
    expect(endpoints[2]?.kind).toBe("openai-compat");
  });

  it("returns no catalog unless sharing is enabled", async () => {
    expect(await discoverLocalModelCatalog({ env: {} })).toBeNull();
    expect(await discoverLocalModelCatalog({
      env: { BRIDGE_SHARE_MODELS: "true", BRIDGE_MODEL_DISCOVERY: "off" },
    })).toBeNull();
  });

  it("advertises models from a mocked OpenAI-compatible server", async () => {
    const mocked = await listen((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "llama3.2", name: "Llama 3.2" }, { id: "qwen2.5" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const catalog = await discoverLocalModelCatalog({
        env: {
          BRIDGE_SHARE_MODELS: "true",
          BRIDGE_MODEL_ENDPOINTS: mocked.url,
        },
        fetch: async (input, init) => {
          if (!String(input).startsWith(mocked.url)) throw new Error("default probe skipped");
          return fetch(input, init);
        },
      });
      expect(catalog?.kind).toBe("local-models");
      const extra = catalog?.servers.find((row) => row.baseUrl === mocked.url);
      expect(extra).toMatchObject({
        kind: "openai-compat",
        models: [
          { id: "llama3.2", name: "Llama 3.2" },
          { id: "qwen2.5", name: "qwen2.5" },
        ],
      });
    } finally {
      await mocked.close();
    }
  });
});

describe("fleet chat job", () => {
  it("relays SSE chunks as Hermes-shaped runtime events", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
      expect(body).toMatchObject({ model: "llama3.2", stream: true });
      const sse = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const result = await runFleetChatJob({
      payload: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-1",
        turnId: "turn-1",
      },
    }, undefined, fetchImpl);
    expect(result.exitCode).toBe(0);
    const wire = parseFleetChatResult(result.stdout);
    expect(wire.kind).toBe("fleet-chat");
    expect(wire.body.ok).toBe(true);
    expect(wire.body.events.map((event) => event.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(wire.body.events.filter((event) => event.type === "content.delta").map((event) => event.delta)).toEqual([
      "Hello",
      " world",
    ]);
    const completed = wire.body.events.find((event) => event.type === "item.completed");
    expect(completed).toMatchObject({ itemType: "assistant_text", text: "Hello world" });
  });

  it("rejects non-loopback base URLs", async () => {
    const result = await runFleetChatJob({
      payload: {
        baseUrl: "http://example.com/v1",
        model: "llama3.2",
        messages: [{ role: "user", content: "hi" }],
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/invalid fleet chat payload/i);
  });
});
