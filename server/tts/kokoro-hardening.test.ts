import { afterEach, describe, expect, it, vi } from "vitest";
import { listKokoroVoices, synthesizeKokoro } from "./kokoro.ts";

afterEach(() => vi.useRealTimers());
const baseUrl = "http://127.0.0.1:18880/v1";

describe("Kokoro request boundaries", () => {
  it("clears every deadline after a successful request", async () => {
    vi.useFakeTimers();
    await listKokoroVoices({ baseUrl, fetch: vi.fn(async () => Response.json({ voices: ["af_heart"] })) });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a response body that stalls after HTTP headers", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } }));
    await expect(listKokoroVoices({ baseUrl, fetch: fetcher, timeoutMs: 15 })).rejects.toThrow(/timed out/i);
    expect(cancelled).toBe(true);
  }, 250);
  it("cancels a request when its caller leaves without waiting for the deadline", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    const pending = listKokoroVoices({ baseUrl, fetch: fetcher, signal: abort.signal, timeoutMs: 100 });
    const result = expect(pending).rejects.toThrow(/cancelled/i);
    abort.abort();
    await result;
  }, 250);
  it("does not forward private endpoint error details", async () => {
    const fetcher = vi.fn(async () => Response.json({ detail: "DO_NOT_FORWARD_PRIVATE_DETAIL" }, { status: 503 }));
    const error = await listKokoroVoices({ baseUrl, fetch: fetcher }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("DO_NOT_FORWARD");
    expect((error as Error).message).toContain("503");
  });
  it("filters malformed ids and deduplicates the actual object catalog", async () => {
    const fetcher = vi.fn(async () => Response.json({ voices: [
      { id: "af_heart", name: "Heart" }, "af_heart", { id: {}, name: "bad" },
      "https://private.invalid/voice", { id: "am_adam", name: "Adam" },
    ] }));
    expect(await listKokoroVoices({ baseUrl, fetch: fetcher })).toEqual([
      { id: "af_heart", label: "Heart" }, { id: "am_adam", label: "Adam" },
    ]);
  });
  it("rejects an empty MPEG response", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(), { headers: { "content-type": "audio/mpeg" } }));
    await expect(synthesizeKokoro("Hello", "af_heart", { baseUrl, fetch: fetcher, skipVoiceCheck: true })).rejects.toThrow(/empty audio/i);
  });
});
