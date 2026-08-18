// The local driver against a tiny fake OpenAI-shaped host: /v1/models (what
// is pulled), /api/ps (what is running, and its window), /v1/chat/completions
// with SSE. Also the failure that matters most for a local server: nothing
// listening — the snapshot must say so, in the CLI engines' vocabulary.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { LocalDriver } from "./local.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import type { ProviderInstance } from "../contracts.ts";

let server: Server | null = null;
let instance: ProviderInstance | null = null;
let recorder: EventRecorder | null = null;
const seen: Array<{ url: string; body: any; auth: string | undefined }> = [];

function fakeHost(opts: { running?: string[]; pulled?: string[]; ctx?: Record<string, number> } = {}) {
  const pulled = opts.pulled ?? ["qwen3:8b", "llama3.2:latest"];
  const running = opts.running ?? ["qwen3:8b"];
  const ctx = opts.ctx ?? { "qwen3:8b": 40960 };
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url ?? "", body, auth: req.headers.authorization });
      const json = (code: number, o: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url === "/v1/models") return json(200, { object: "list", data: pulled.map((id) => ({ id, object: "model" })) });
      if (req.url === "/api/ps") return json(200, { models: running.map((m) => ({ name: m, model: m, context_length: ctx[m] })) });
      if (req.url === "/v1/chat/completions") {
        if (!body.stream) return json(200, { choices: [{ message: { content: `sync reply to ${body.messages.at(-1).content}` } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ choices: [{ delta: { content: "hello " } }] });
        send({ choices: [{ delta: { content: "from local" } }] });
        send({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 2 } });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      json(404, { error: "nope" });
    });
  });
  return new Promise<string>((resolve) => server!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as any).port}/v1`)));
}

const create = async (url: string, host = "ollama") => {
  instance = await LocalDriver.create({ instanceId: "local-test", displayName: undefined, environment: {}, enabled: true, config: { host, url } });
  recorder = recordEvents(instance.adapter);
};

afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = null;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  seen.length = 0;
});

describe("LocalDriver", () => {
  it("builds its catalog from the host: pulled models, running ones first and flagged, windows from /api/ps", async () => {
    await create(await fakeHost());
    const opts = instance!.models.options;
    expect(opts.map((o) => o.id)).toEqual(["qwen3:8b", "llama3.2:latest"]);
    expect(opts[0]).toMatchObject({ loaded: true, contextWindow: 40960 });
    expect(opts[1].loaded).toBeUndefined();
    expect(instance!.models.default).toBe("qwen3:8b");
    expect(instance!.displayName).toBe("Ollama");
    await expect(instance!.snapshot()).resolves.toMatchObject({ state: "available" });
    // keyless hosts still get a bearer — some hide their models without one
    expect(seen.find((s) => s.url === "/v1/models")?.auth).toMatch(/^Bearer /);
  });

  it("says the host isn't running when nothing listens, and recovers on refresh", async () => {
    await create("http://127.0.0.1:1/v1"); // nothing there
    expect(instance!.models.options).toEqual([]);
    const snap = await instance!.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/isn't running/);
    // sending with no model is a clear error, not a hang
    await expect(instance!.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/no model to run/);
  });

  it("streams a turn from the transcript with a system role, banks usage, settles", async () => {
    await create(await fakeHost());
    const { turnId } = await instance!.adapter.sendTurn({
      threadId: "t1",
      text: "hi",
      system: "You are Wren.",
      transcript: [{ role: "user", text: "earlier" }, { role: "assistant", text: "noted" }],
    });
    await recorder!.until((e) => e.type === "turn.completed");
    const types = recorder!.events.map((e) => e.type);
    expect(types).toEqual(["turn.started", "session.started", "content.delta", "content.delta", "item.completed", "thread.token-usage.updated", "turn.completed"]);
    const done = recorder!.events.at(-1) as any;
    expect(done).toMatchObject({ turnId, ok: true, usage: { input: 12, output: 2 } });
    const req = seen.find((s) => s.url === "/v1/chat/completions")!;
    expect(req.body.model).toBe("qwen3:8b");
    expect(req.body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(req.body.messages[0].role).toBe("system"); // not "developer"
    expect(req.body.stream).toBe(true);
  });

  it("generateText uses the host's default model, unstreamed", async () => {
    await create(await fakeHost());
    await expect(instance!.generateText!("summarize this")).resolves.toBe("sync reply to summarize this");
  });

  it("interrupt aborts the in-flight request and settles as interrupted", async () => {
    await create(await fakeHost());
    // a host that never finishes: hold the response open
    await new Promise<void>((r) => server!.close(() => r()));
    server = createServer((req, res) => {
      if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "slow" }] })); }
      res.writeHead(200, { "content-type": "text/event-stream" }); // never ends
    });
    const url = await new Promise<string>((resolve) => server!.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as any).port}/v1`)));
    recorder?.stop();
    await instance!.dispose();
    await create(url);
    await instance!.adapter.sendTurn({ threadId: "t2", text: "hang" });
    await instance!.adapter.interruptTurn("t2");
    await recorder!.until((e) => e.type === "turn.completed");
    expect(recorder!.events.at(-1)).toMatchObject({ ok: false, stopReason: "interrupted" });
  });
});
