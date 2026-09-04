import { newEventId, type RuntimeEvent } from "../../server/contracts.ts";
import {
  DEFAULT_FLEET_DISCOVERY_INTERVAL_MS,
  encodeFleetChatResult,
  normalizeModelBaseUrl,
  parseFleetChatJobPayload,
  scrubFleetChatEvents,
  serverKindForBaseUrl,
  type FleetChatJobPayload,
  type LocalModelDescriptor,
  type LocalModelServer,
  type LocalModelServerKind,
  type LocalModelsPayload,
} from "../../shared/bridge-fleet-contract.ts";
import type { BridgeJobResult } from "./types.ts";

export const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434/v1";
export const DEFAULT_LMSTUDIO_BASE = "http://127.0.0.1:1234/v1";
const PROBE_TIMEOUT_MS = 2_500;
const CHAT_TIMEOUT_MS = 180_000;

export function shareLocalModels(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BRIDGE_SHARE_MODELS === "true";
}

export function modelDiscoveryIntervalMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.BRIDGE_MODEL_DISCOVERY?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return null;
  if (!raw) return DEFAULT_FLEET_DISCOVERY_INTERVAL_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  return DEFAULT_FLEET_DISCOVERY_INTERVAL_MS;
}

export function discoveryEndpoints(env: NodeJS.ProcessEnv = process.env): Array<{
  kind: LocalModelServerKind;
  baseUrl: string;
}> {
  const endpoints: Array<{ kind: LocalModelServerKind; baseUrl: string }> = [
    { kind: "ollama", baseUrl: DEFAULT_OLLAMA_BASE },
    { kind: "lmstudio", baseUrl: DEFAULT_LMSTUDIO_BASE },
  ];
  const extra = env.BRIDGE_MODEL_ENDPOINTS ?? "";
  for (const part of extra.split(",")) {
    const baseUrl = normalizeModelBaseUrl(part);
    if (!baseUrl) continue;
    if (endpoints.some((row) => row.baseUrl === baseUrl)) continue;
    endpoints.push({ kind: serverKindForBaseUrl(baseUrl), baseUrl });
  }
  return endpoints;
}

function asModelName(row: { id: string; name?: unknown }): string {
  return typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.id;
}

function parseModelsBody(json: unknown): LocalModelDescriptor[] {
  const rows: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === "object" && !Array.isArray(json)
      ? Array.isArray((json as { data?: unknown }).data)
        ? (json as { data: unknown[] }).data
        : Array.isArray((json as { models?: unknown }).models)
          ? (json as { models: unknown[] }).models
          : []
      : [];
  const seen = new Set<string>();
  const models: LocalModelDescriptor[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: asModelName({ id, name: (row as { name?: unknown }).name }) });
  }
  return models;
}

export async function probeModelServer(
  baseUrl: string,
  kind: LocalModelServerKind,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalModelServer | null> {
  const normalized = normalizeModelBaseUrl(baseUrl);
  if (!normalized) return null;
  try {
    const res = await fetchImpl(`${normalized}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return { kind, baseUrl: normalized, models: parseModelsBody(json) };
  } catch {
    return null;
  }
}

export async function discoverLocalModelCatalog(input: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
} = {}): Promise<LocalModelsPayload | null> {
  const env = input.env ?? process.env;
  if (!shareLocalModels(env)) return null;
  if (modelDiscoveryIntervalMs(env) === null) return null;
  const fetchImpl = input.fetch ?? fetch;
  const servers: LocalModelServer[] = [];
  for (const endpoint of discoveryEndpoints(env)) {
    const probed = await probeModelServer(endpoint.baseUrl, endpoint.kind, fetchImpl);
    if (probed) servers.push(probed);
  }
  return { kind: "local-models", servers };
}

function baseEvent(payload: FleetChatJobPayload): Omit<RuntimeEvent, "type"> {
  return {
    eventId: newEventId(),
    provider: "fleet",
    threadId: payload.threadId,
    turnId: payload.turnId,
    createdAt: new Date().toISOString(),
  };
}

async function streamChatCompletions(
  payload: FleetChatJobPayload,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  onDelta?: (delta: string, streamKind: "assistant_text" | "reasoning_text") => void,
): Promise<{ text: string; usage: { input: number; output: number } | null }> {
  const res = await fetchImpl(`${payload.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages,
      stream: true,
    }),
    signal: signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`upstream HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  if (!res.body) throw new Error("upstream returned no body");
  let text = "";
  let usage: { input: number; output: number } | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: {
        choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
      const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
      if (reasoningDelta) onDelta?.(reasoningDelta, "reasoning_text");
      if (contentDelta) {
        text += contentDelta;
        onDelta?.(contentDelta, "assistant_text");
      }
      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        };
      }
    }
  }
  return { text, usage };
}

export async function runFleetChatJob(
  job: { payload: unknown },
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeJobResult> {
  if (signal?.aborted) {
    return { exitCode: 1, stdout: "", stderr: "cancelled", truncated: false };
  }
  const payload = parseFleetChatJobPayload(job.payload);
  if (!payload) {
    return { exitCode: 1, stdout: "", stderr: "invalid fleet chat payload", truncated: false };
  }
  const events: RuntimeEvent[] = [
    { ...baseEvent(payload), eventId: newEventId(), type: "turn.started" },
    {
      ...baseEvent(payload),
      eventId: newEventId(),
      type: "session.started",
      sessionId: null,
      model: payload.model,
    },
  ];
  try {
    const { text, usage } = await streamChatCompletions(payload, fetchImpl, signal, (delta, streamKind) => {
      events.push({
        ...baseEvent(payload),
        eventId: newEventId(),
        type: "content.delta",
        streamKind,
        delta,
      });
    });
    if (signal?.aborted) {
      return { exitCode: 1, stdout: "", stderr: "cancelled", truncated: false };
    }
    if (text.trim()) {
      events.push({
        ...baseEvent(payload),
        eventId: newEventId(),
        type: "item.completed",
        itemType: "assistant_text",
        text,
      });
    }
    events.push({
      ...baseEvent(payload),
      eventId: newEventId(),
      type: "turn.completed",
      ok: true,
      stopReason: null,
      ...(usage ? { usage } : {}),
    });
    return {
      exitCode: 0,
      stdout: encodeFleetChatResult({
        kind: "fleet-chat",
        body: { ok: true, turnId: payload.turnId, events: scrubFleetChatEvents(events) },
      }),
      stderr: "",
      truncated: false,
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { exitCode: 1, stdout: "", stderr: "cancelled", truncated: false };
    }
    events.push({
      ...baseEvent(payload),
      eventId: newEventId(),
      type: "runtime.error",
      message: "Hermes request failed",
    });
    events.push({
      ...baseEvent(payload),
      eventId: newEventId(),
      type: "turn.completed",
      ok: false,
      stopReason: "error",
    });
    return {
      exitCode: 0,
      stdout: encodeFleetChatResult({
        kind: "fleet-chat",
        body: { ok: false, turnId: payload.turnId, events: scrubFleetChatEvents(events) },
      }),
      stderr: "",
      truncated: false,
    };
  }
}
