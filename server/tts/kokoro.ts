// Operator-owned Kokoro endpoint. Paired clients never supply a URL, model,
// method or credential, and failures never fall back to a cloud provider.
import type { Audio, Voice } from "./elevenlabs.ts";

export const KOKORO_VOICES_MAX_BYTES = 256 * 1024;
export const KOKORO_AUDIO_MAX_BYTES = 2 * 1024 * 1024;
const VOICE_TIMEOUT_MS = 10_000;
const SPEECH_TIMEOUT_MS = 30_000;
const VOICE_ID = /^[a-z]{2}_[a-z0-9]+(?:_[a-z0-9]+)*$/i;
export type KokoroFetch = typeof fetch;

class KokoroError extends Error {}
export class IncompatibleKokoroVoice extends Error {
  constructor() {
    super("This agent's current voice is not available on the Kokoro provider. Pick a Kokoro voice in the agent profile.");
    this.name = "IncompatibleKokoroVoice";
  }
}
export function isKokoroVoiceId(id: string | undefined): boolean {
  return Boolean(id && id.length <= 80 && VOICE_ID.test(id.trim()));
}
export function normalizeKokoroBaseUrl(raw: string | undefined):
  { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Kokoro is not configured on this hub. Set OMB_KOKORO_BASE_URL." };
  if (raw.length > 2048) return { ok: false, error: "Kokoro URL is too long." };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, error: "Kokoro URL is invalid." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Kokoro URL must be http or https." };
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "Kokoro URL must not include credentials, a query, or a hash." };
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/v1") return { ok: false, error: "Kokoro URL must point at the /v1 API root." };
  return { ok: true, url: `${url.origin}/v1` };
}
export function kokoroEndpoint(raw = process.env.OMB_KOKORO_BASE_URL): string | null {
  const result = normalizeKokoroBaseUrl(raw);
  return result.ok ? result.url : null;
}
function resolveBase(raw?: string): string {
  const result = normalizeKokoroBaseUrl(raw ?? process.env.OMB_KOKORO_BASE_URL);
  if (!result.ok) throw new KokoroError(result.error);
  return result.url;
}

async function readBounded(response: Response, max: number, what: string, signal: AbortSignal): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max) throw new KokoroError(`Kokoro ${what} is too large.`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw new KokoroError(`Kokoro ${what} is too large.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new KokoroError(`Kokoro ${what} is too large.`);
      }
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** One deadline covers headers AND the entire bounded body. */
async function fetchBounded(fetcher: KokoroFetch, url: string, init: RequestInit, max: number, what: string, timeoutMs: number, callerSignal?: AbortSignal): Promise<{ response: Response; bytes: Uint8Array }> {
  if (callerSignal?.aborted) throw new KokoroError("Kokoro request cancelled.");
  const controller = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    cancel = () => { reject(new KokoroError("Kokoro request cancelled.")); controller.abort(); };
    callerSignal?.addEventListener("abort", cancel, { once: true });
    if (callerSignal?.aborted) cancel();
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new KokoroError("Kokoro timed out waiting for a response."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const operation = async () => {
      response = await fetcher(url, { ...init, redirect: "error", signal: controller.signal });
      const bytes = await readBounded(response, max, what, controller.signal);
      if (!response.ok) throw new KokoroError(`Kokoro ${what} failed (${response.status}). Check the voice server.`);
      return { response, bytes };
    };
    return await Promise.race([operation(), deadline, cancellation]);
  } catch (error) {
    // Provider error bodies and transport errors may contain private URLs,
    // paths or credentials. Only locally constructed messages reach clients.
    if (error instanceof KokoroError) throw error;
    throw new KokoroError("Couldn't reach the Kokoro voice server. Check that it is running and OMB_KOKORO_BASE_URL is set.");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
    controller.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

function parseVoiceList(payload: unknown): Voice[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { voices?: unknown }).voices)) {
    throw new KokoroError("Kokoro did not return a voice list.");
  }
  const catalog = (payload as { voices: unknown[] }).voices;
  if (catalog.length > 256) throw new KokoroError("Kokoro voice list is too large.");
  const voices: Voice[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    const rawId = typeof entry === "string" ? entry : record?.id;
    if (typeof rawId !== "string" || !isKokoroVoiceId(rawId)) continue;
    const id = rawId.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const label = typeof record?.name === "string" ? record.name.trim().slice(0, 120) || id : id;
    voices.push({ id, label });
  }
  return voices;
}

export async function listKokoroVoices(opts: { fetch?: KokoroFetch; baseUrl?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Voice[]> {
  const base = resolveBase(opts.baseUrl);
  const { bytes } = await fetchBounded(opts.fetch ?? fetch, `${base}/audio/voices`,
    { method: "GET", headers: { accept: "application/json" } },
    KOKORO_VOICES_MAX_BYTES, "voice list", opts.timeoutMs ?? VOICE_TIMEOUT_MS, opts.signal);
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new KokoroError("Kokoro did not return a valid voice list."); }
  return parseVoiceList(payload);
}

export async function synthesizeKokoro(text: string, voiceId: string, opts: {
  fetch?: KokoroFetch; baseUrl?: string; timeoutMs?: number; skipVoiceCheck?: boolean; signal?: AbortSignal;
} = {}): Promise<Audio> {
  const base = resolveBase(opts.baseUrl);
  if (!text.trim() || text.length > 500) throw new KokoroError("Kokoro speech must contain 1 to 500 characters.");
  if (!isKokoroVoiceId(voiceId)) throw new IncompatibleKokoroVoice();
  const fetcher = opts.fetch ?? fetch;
  if (!opts.skipVoiceCheck) {
    const voices = await listKokoroVoices({ fetch: fetcher, baseUrl: base, timeoutMs: opts.timeoutMs ?? VOICE_TIMEOUT_MS, signal: opts.signal });
    if (!voices.some((voice) => voice.id === voiceId)) throw new IncompatibleKokoroVoice();
  }
  const { response, bytes } = await fetchBounded(fetcher, `${base}/audio/speech`, {
    method: "POST", headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ model: "kokoro", input: text, voice: voiceId, response_format: "mp3", stream: false }),
  }, KOKORO_AUDIO_MAX_BYTES, "audio", opts.timeoutMs ?? SPEECH_TIMEOUT_MS, opts.signal);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mime !== "audio/mpeg" && mime !== "audio/mp3") throw new KokoroError("Kokoro did not return mpeg audio.");
  if (!bytes.length) throw new KokoroError("Kokoro returned empty audio.");
  return { bytes, mime: "audio/mpeg" };
}
