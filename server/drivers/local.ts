// Local driver — a local OpenAI-shaped server (Ollama, LM Studio, oMLX,
// EXO, Unsloth, or any URL) spoken to DIRECTLY, no CLI in between. The
// no-CLI path: a bot runs on a locally pulled model with no account and no
// agent installed. Where an agent CLI IS installed, prefer the injected
// route (local-inject.ts) — a CLI keeps tools, approvals and the computer;
// this driver is a chat bot, and says so in its capabilities.
//
// Like grok.ts it is transcript-replay (SendTurnInput.transcript feeds it,
// sized by the harness's rebuild) and streams true token deltas. Unlike
// grok.ts its snapshot and catalog come from the HOST: /v1/models is what
// is pulled, /api/ps (Ollama) is what is running and how big its window is,
// and a refused connection is "not running" with the command that starts
// it — the same vocabulary the CLI engines use in the picker.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { contextWindowsFromPs, hostApiKey, LOCAL_HOSTS, loadedIdsFromPayloads, type LocalHost } from "./local-inject.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "local";
const PROBE_MS = 2_500;
const TURN_MS = 10 * 60_000;

export interface LocalConfig {
  /** one of LOCAL_HOSTS' ids, or "custom" with a url */
  host: string;
  /** base URL ending in /v1 — required for custom, overrides the host default otherwise */
  url?: string;
}

const CUSTOM: LocalHost = { id: "custom", label: "Local server", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "local" };

function hostFor(config: LocalConfig): LocalHost {
  const known = LOCAL_HOSTS.find((h) => h.id === config.host);
  const base = known ?? CUSTOM;
  return config.url ? { ...base, baseUrl: config.url.replace(/\/$/, "") } : base;
}

function decodeConfig(raw: unknown): LocalConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const host = typeof o.host === "string" && o.host ? o.host : "ollama";
  const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined;
  if (host === "custom" && !url) throw new Error("a custom local server needs a url");
  return { host, url };
}

/** What to run when the host is not answering — the CLI engines' signInCommand slot. */
function startCommandFor(host: LocalHost): string | undefined {
  switch (host.id) {
    case "ollama":
    case "local_ollama":
      return "ollama serve";
    case "omlx":
      return "omlx serve";
    case "exo":
      return "exo";
    case "lmstudio":
      return "open -a 'LM Studio'";
    default:
      return undefined;
  }
}

/** Ollama's /api/ps lives beside /v1 on the same origin. */
function psUrl(host: LocalHost): string | null {
  const origin = host.baseUrl.replace(/\/v1\/?$/, "");
  return host.id === "ollama" || host.id === "local_ollama" ? `${origin}/api/ps` : null;
}

const EMPTY: ModelCatalog = { default: "", options: [] };

export const LocalDriver: ProviderDriver<LocalConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Local models", supportsMultipleInstances: true },
  models: EMPTY,
  install: {
    command: {
      darwin: "brew install ollama",
      linux: "curl -fsSL https://ollama.com/install.sh | sh",
    },
    docsUrl: "https://ollama.com/download",
    // not a sign-in — the "start it" command the setup card offers when the
    // host is installed but not answering
    signInCommand: "ollama serve",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<LocalConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const host = hostFor(config);
    const env = { ...process.env, ...input.environment };
    // keyless servers still want a bearer — some hide their models without one
    const apiKey = hostApiKey(host, env);
    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();
    let models: ModelCatalog = EMPTY;
    let lastProbe: { ok: boolean; reason?: string } = { ok: false, reason: "not probed yet" };

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const getJson = async (url: string): Promise<unknown> => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };

    /** /v1/models is what is pulled; /api/ps (Ollama) marks what is running
     * and reports its window. Missing host → an empty catalog and a reason. */
    const refreshModels = async () => {
      try {
        const catalog = await getJson(`${host.baseUrl}/models`);
        const ps = psUrl(host);
        const extra = ps ? await getJson(ps).catch(() => null) : null;
        const ids = Array.isArray((catalog as { data?: unknown[] })?.data)
          ? ((catalog as { data: Array<{ id?: unknown }> }).data.map((m) => m.id).filter((id): id is string => typeof id === "string"))
          : [];
        const loaded = loadedIdsFromPayloads(host, catalog, extra);
        const windows = contextWindowsFromPs(extra);
        // running models first, then the rest — a picker's job is to show
        // what will answer NOW at the top
        const sorted = [...ids].sort((a, b) => Number(loaded.has(b)) - Number(loaded.has(a)) || a.localeCompare(b));
        models = {
          default: sorted[0] ?? "",
          options: sorted.map((id) => ({
            id,
            label: `${id} (${host.label})`,
            ...(loaded.has(id) ? { loaded: true } : {}),
            ...(windows.get(id) ? { contextWindow: windows.get(id) } : {}),
          })),
        };
        lastProbe = { ok: true };
      } catch (e) {
        models = EMPTY;
        const why = e instanceof Error ? e.message : String(e);
        const start = startCommandFor(host);
        lastProbe = {
          ok: false,
          reason: /ECONNREFUSED|fetch failed|timeout|Timeout/i.test(why)
            ? `${host.label} isn't running at ${host.baseUrl}${start ? ` — start it with \`${start}\`` : ""}`
            : `${host.label}: ${why}`,
        };
      }
    };
    await refreshModels();

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
    ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
      const res = await fetch(`${host.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        // stream_options is how OpenAI-shaped servers include usage in the
        // final SSE chunk; servers that don't know it ignore it
        body: JSON.stringify({ model, messages, stream: opts.stream, ...(opts.stream ? { stream_options: { include_usage: true } } : {}) }),
        signal: opts.signal ?? AbortSignal.timeout(TURN_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${host.label} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          usage: json.usage ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 } : null,
        };
      }
      let text = "";
      let usage: { input: number; output: number } | null = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
        }
      }
      return { text, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const model = turn.model || models.default;
      if (!model) throw new Error(`no model to run — ${lastProbe.reason ?? `pull one on ${host.label} first`}`);
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      // `system`, not `developer`: local servers know the OpenAI shape as
      // it was, not the newer role (learned from pi)
      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text })),
        { role: "user", content: turn.text },
      ];
      appendNative(threadId, { dir: "out", source: "local.chat.completions", msg: { host: host.id, model, messages } });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

      (async () => {
        try {
          const { text, usage } = await complete(messages, model, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta) => emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
          });
          appendNative(threadId, { dir: "in", source: "local.chat.completions", msg: { text, usage } });
          if (text.trim()) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          if (usage) emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null, ...(usage ? { usage } : {}) });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: aborted ? "interrupted" : "error", cost: null });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      await refreshModels();
      if (!lastProbe.ok) return { state: "unavailable", reason: lastProbe.reason, notRunning: /isn't running/.test(lastProbe.reason ?? "") };
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName ?? host.label,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        // a bare API: no MCP, no asks, no computer, no live session — the
        // injected-CLI route is where those live
        capabilities: { sessionModelSwitch: "in-session", computerMcp: false, agentsMcp: false, composioMcp: false, queueing: false },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const model = models.default;
        if (!model) throw new Error(`no local model to summarize with — ${lastProbe.reason ?? "none pulled"}`);
        const { text } = await complete([{ role: "user", content: prompt }], model, { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};

export { startCommandFor as localStartCommand };
