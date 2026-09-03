import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { decodeZaiConfig, ZaiDriver } from "./zai.ts";

describe("ZaiDriver", () => {
  const saved = {
    key: process.env.ZAI_API_KEY,
    url: process.env.ZAI_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.ZAI_API_KEY;
    delete process.env.ZAI_BASE_URL;
  });

  afterEach(() => {
    if (saved.key === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.ZAI_BASE_URL;
    else process.env.ZAI_BASE_URL = saved.url;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the GLM coding-plan model catalog", () => {
    expect(ZaiDriver.models).toEqual({
      default: "glm-4.6",
      options: [
        { id: "glm-4.6", label: "GLM-4.6", contextWindow: 200_000 },
        { id: "glm-4.5", label: "GLM-4.5", contextWindow: 128_000 },
        { id: "glm-4.5-air", label: "GLM-4.5 Air", contextWindow: 128_000 },
      ],
    });
  });

  it("defaults to the coding-plan base and honors config and env overrides", () => {
    expect(decodeZaiConfig({})).toEqual({ baseUrl: "https://api.z.ai/api/coding/paas/v4" });
    expect(decodeZaiConfig({ baseUrl: "https://api.z.ai/api/paas/v4/" }))
      .toEqual({ baseUrl: "https://api.z.ai/api/paas/v4" });
    process.env.ZAI_BASE_URL = "https://proxy.example.test/v4";
    expect(decodeZaiConfig({})).toEqual({ baseUrl: "https://proxy.example.test/v4" });
    // a per-instance override beats the env fallback
    expect(decodeZaiConfig({ baseUrl: "https://instance.example.test/v4" }))
      .toEqual({ baseUrl: "https://instance.example.test/v4" });
  });

  it("reports unavailable without a key and available without probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const instance = await ZaiDriver.create({
      instanceId: "zai-test",
      displayName: "ZAI (GLM)",
      enabled: true,
      config: ZaiDriver.defaultConfig(),
      environment: {},
    });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "unavailable" });
    await expect(instance.adapter.sendTurn({ threadId: "thread", text: "hello" })).rejects.toThrow(/no Z\.ai key/);
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("skips blank instance credentials without masking a process-env key", async () => {
    process.env.ZAI_API_KEY = "env-key";
    const instance = await ZaiDriver.create({
      instanceId: "zai-blank",
      displayName: "ZAI (GLM)",
      enabled: true,
      config: ZaiDriver.defaultConfig(),
      environment: { ZAI_API_KEY: "   " },
    });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true });
    await instance.dispose();
  });

  it("streams content and usage to the coding-plan chat/completions endpoint", async () => {
    let url: string | undefined;
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input);
      request = init;
      return new Response(
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
          "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await ZaiDriver.create({
      instanceId: "zai-turn",
      displayName: "ZAI (GLM)",
      enabled: true,
      config: ZaiDriver.defaultConfig(),
      environment: { ZAI_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "private prompt",
      system: "you are a bot",
      transcript: [{ role: "user", text: "earlier" }],
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    const body = JSON.parse(String(request?.body));

    expect(url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(body).toMatchObject({
      model: "glm-4.6",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "you are a bot" },
        { role: "user", content: "earlier" },
        { role: "user", content: "private prompt" },
      ],
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await instance.dispose();
  });

  it("reports a bodyless stream clearly and releases the turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const instance = await ZaiDriver.create({
      instanceId: "zai-empty",
      displayName: "ZAI (GLM)",
      enabled: true,
      config: ZaiDriver.defaultConfig(),
      environment: { ZAI_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(error).toMatchObject({ message: "Z.ai returned no response body" });
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });
});
