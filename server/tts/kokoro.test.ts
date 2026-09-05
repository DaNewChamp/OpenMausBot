// Kokoro FastAPI, driven against an injected fetch — what we send, what we
// refuse, and that a local failure never becomes a cloud call.
import { describe, expect, it, vi } from "vitest";

import {
  KOKORO_AUDIO_MAX_BYTES,
  KOKORO_VOICES_MAX_BYTES,
  listKokoroVoices,
  normalizeKokoroBaseUrl,
  synthesizeKokoro,
} from "./kokoro.ts";

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
const SAMPLE = "The overnight notes are ready.";

type FetchCall = { url: string; init?: RequestInit };
const calls: FetchCall[] = [];

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function audioResponse(bytes: Uint8Array | Buffer, mime = "audio/mpeg", headers: Record<string, string> = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": mime, ...headers },
  });
}

function recordFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  calls.length = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

describe("normalizeKokoroBaseUrl", () => {
  it("fails closed when the operator URL is missing", () => {
    const result = normalizeKokoroBaseUrl(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not configured/i);
    expect(normalizeKokoroBaseUrl("").ok).toBe(false);
    expect(normalizeKokoroBaseUrl("   ").ok).toBe(false);
  });

  it("accepts http/https and normalizes the /v1 root", () => {
    expect(normalizeKokoroBaseUrl("http://127.0.0.1:8880")).toEqual({
      ok: true,
      url: "http://127.0.0.1:8880/v1",
    });
    expect(normalizeKokoroBaseUrl("http://127.0.0.1:8880/")).toEqual({
      ok: true,
      url: "http://127.0.0.1:8880/v1",
    });
    expect(normalizeKokoroBaseUrl("https://voices.example/v1")).toEqual({
      ok: true,
      url: "https://voices.example/v1",
    });
    expect(normalizeKokoroBaseUrl("https://voices.example/v1/")).toEqual({
      ok: true,
      url: "https://voices.example/v1",
    });
  });

  it("rejects userinfo, hash, query, and non-http schemes", () => {
    expect(normalizeKokoroBaseUrl("http://user:secret@127.0.0.1:8880/v1").ok).toBe(false);
    expect(normalizeKokoroBaseUrl("http://127.0.0.1:8880/v1#frag").ok).toBe(false);
    expect(normalizeKokoroBaseUrl("http://127.0.0.1:8880/v1?legacy=true").ok).toBe(false);
    expect(normalizeKokoroBaseUrl("ftp://127.0.0.1:8880/v1").ok).toBe(false);
    expect(normalizeKokoroBaseUrl("http://127.0.0.1:8880/v1/audio").ok).toBe(false);
    const secret = normalizeKokoroBaseUrl("http://user:hunter2@127.0.0.1:8880/v1");
    expect(secret.ok).toBe(false);
    if (!secret.ok) {
      expect(secret.error).not.toContain("hunter2");
      expect(secret.error).not.toContain("user:");
    }
  });
});

describe("listKokoroVoices", () => {
  it("parses the live {id,name} object shape", async () => {
    const fetch = recordFetch(() =>
      jsonResponse(200, {
        voices: [
          { id: "af_heart", name: "af_heart" },
          { id: "af_bella", name: "Bella" },
        ],
      }),
    );
    await expect(
      listKokoroVoices({ fetch, baseUrl: "http://127.0.0.1:8880/v1" }),
    ).resolves.toEqual([
      { id: "af_heart", label: "af_heart" },
      { id: "af_bella", label: "Bella" },
    ]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8880/v1/audio/voices");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.headers).not.toHaveProperty("authorization");
  });

  it("parses the documented legacy string shape", async () => {
    const fetch = recordFetch(() => jsonResponse(200, { voices: ["af_heart", "bm_george"] }));
    await expect(
      listKokoroVoices({ fetch, baseUrl: "http://127.0.0.1:8880/v1" }),
    ).resolves.toEqual([
      { id: "af_heart", label: "af_heart" },
      { id: "bm_george", label: "bm_george" },
    ]);
  });

  it("refuses an oversized voice list without parsing it", async () => {
    const fetch = recordFetch(() =>
      jsonResponse(200, { voices: ["af_heart"] }, { "content-length": String(KOKORO_VOICES_MAX_BYTES + 1) }),
    );
    const message = await listKokoroVoices({ fetch, baseUrl: "http://127.0.0.1:8880/v1" }).catch(
      (e: Error) => e.message,
    );
    expect(message).toMatch(/too large/i);
    expect(message).not.toContain("127.0.0.1");
  });

  it("says what to do when the voice server is unreachable, without leaking the URL", async () => {
    const fetch = recordFetch(() => {
      throw new Error("connect ECONNREFUSED 10.1.2.3:8880");
    });
    const message = await listKokoroVoices({ fetch, baseUrl: "http://10.1.2.3:8880/v1" }).catch(
      (e: Error) => e.message,
    );
    expect(message).toMatch(/couldn't reach|not reachable|Kokoro/i);
    expect(message).not.toContain("10.1.2.3");
  });
});

describe("synthesizeKokoro", () => {
  it("posts model kokoro, mp3, stream false, and returns mpeg bytes", async () => {
    const fetch = recordFetch((url) => {
      if (url.endsWith("/audio/voices")) {
        return jsonResponse(200, { voices: [{ id: "af_heart", name: "af_heart" }] });
      }
      return audioResponse(MP3);
    });
    const audio = await synthesizeKokoro(SAMPLE, "af_heart", {
      fetch,
      baseUrl: "http://127.0.0.1:8880/v1",
    });
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3);

    const speech = calls.find((c) => c.url.endsWith("/audio/speech"))!;
    expect(speech.init?.method).toBe("POST");
    expect(speech.init?.redirect).toBe("error");
    expect(JSON.parse(String(speech.init?.body))).toEqual({
      model: "kokoro",
      input: SAMPLE,
      voice: "af_heart",
      response_format: "mp3",
      stream: false,
    });
    const headers = speech.init?.headers as Record<string, string>;
    expect(JSON.stringify(headers ?? {}).toLowerCase()).not.toContain("authorization");
  });

  it("rejects a non-mpeg MIME rather than playing it", async () => {
    const fetch = recordFetch((url) => {
      if (url.endsWith("/audio/voices")) {
        return jsonResponse(200, { voices: [{ id: "af_heart", name: "af_heart" }] });
      }
      return audioResponse(MP3, "application/json");
    });
    const message = await synthesizeKokoro(SAMPLE, "af_heart", {
      fetch,
      baseUrl: "http://127.0.0.1:8880/v1",
    }).catch((e: Error) => e.message);
    expect(message).toMatch(/audio/i);
  });

  it("refuses oversized audio", async () => {
    const fetch = recordFetch((url) => {
      if (url.endsWith("/audio/voices")) {
        return jsonResponse(200, { voices: [{ id: "af_heart", name: "af_heart" }] });
      }
      return audioResponse(MP3, "audio/mpeg", { "content-length": String(KOKORO_AUDIO_MAX_BYTES + 1) });
    });
    const message = await synthesizeKokoro(SAMPLE, "af_heart", {
      fetch,
      baseUrl: "http://127.0.0.1:8880/v1",
    }).catch((e: Error) => e.message);
    expect(message).toMatch(/too large/i);
  });

  it("times out a hung voice server", async () => {
    vi.useFakeTimers();
    try {
      const fetch = recordFetch(() => new Promise<Response>(() => {}));
      const pending = synthesizeKokoro(SAMPLE, "af_heart", {
        fetch,
        baseUrl: "http://127.0.0.1:8880/v1",
        timeoutMs: 25,
        skipVoiceCheck: true,
      });
      const assertion = expect(pending).rejects.toThrow(/timed out|timeout/i);
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
