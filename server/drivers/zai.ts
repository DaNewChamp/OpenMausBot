// ZAI (GLM) driver — Z.ai GLM Coding Plan over the OpenAI-compatible
// chat/completions API with SSE streaming.
//
// Z.ai exposes several bases (docs.z.ai/devpack/tool/others):
//   OpenAI-compatible, coding plan:  https://api.z.ai/api/coding/paas/v4
//   OpenAI-compatible, standard API: https://api.z.ai/api/paas/v4
//   Anthropic-compatible, coding plan: https://api.z.ai/api/anthropic
// This driver speaks OpenAI chat/completions, so it defaults to the coding
// plan base; set zai.baseUrl (config.json or ZAI_BASE_URL) to the standard
// API base for a pay-as-you-go key. The Anthropic base is listed for
// reference only — pointing this driver at it would not speak its protocol.
//
// The API key is the same workspace secret every cloud provider uses: the
// Connections row (OS-encrypted store → ZAI_API_KEY env at boot) or a plain
// ZAI_API_KEY in the process env.
import { z } from "zod";

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
import { appendNative } from "./native.ts";

const DRIVER_KIND = "zai";
const API_KEY_ENV = "ZAI_API_KEY";
const BASE_URL_ENV = "ZAI_BASE_URL";
// Coding-plan subscription endpoint (OpenAI-compatible).
const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

const MODELS: ModelCatalog = {
  default: "glm-4.6",
  options: [
    { id: "glm-4.6", label: "GLM-4.6", contextWindow: 200_000 },
    { id: "glm-4.5", label: "GLM-4.5", contextWindow: 128_000 },
    { id: "glm-4.5-air", label: "GLM-4.5 Air", contextWindow: 128_000 },
  ],
};

export interface ZaiConfig {
  baseUrl: string;
}

const driverConfigSchema = z.object({
  baseUrl: z.string().optional(),
});

// ProviderDriver supplies untrusted config as unknown; the schema above is
// the I/O boundary that converts it to the driver's concrete contract.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function decodeZaiConfig(raw: unknown): ZaiConfig {
  const parsed = driverConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : {};
  const envUrl = process.env[BASE_URL_ENV]?.trim();
  return {
    baseUrl: (config.baseUrl?.trim() || envUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

export const ZaiDriver: ProviderDriver<ZaiConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ZAI (GLM)", supportsMultipleInstances: true, access: "subscription" },
  models: MODELS,
  install: {
    docsUrl: "https://docs.z.ai/devpack/quick-start",
    signInCommand: "paste your Z.ai API key in Settings → Connections (or set ZAI_API_KEY)",
    command: {
      darwin: "Subscribe to the GLM Coding Plan at https://z.ai, then paste the API key in V Bot Settings → Connections",
      linux: "Subscribe to the GLM Coding Plan at https://z.ai, then paste the API key in V Bot Settings → Connections",
      win32: "Subscribe to the GLM Coding Plan at https://z.ai, then paste the API key in V Bot Settings → Connections",
    },
  },
  decodeConfig: decodeZaiConfig,
  defaultConfig: () => decodeZaiConfig({}),

  async create(input: DriverCreateInput<ZaiConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;

    // Resolution order: instance env → process env. The Connections key
    // arrives as instance env via config injection; empty higher-priority
    // values are skipped instead of masking a real key.
    const apiKey =
      input.environment[API_KEY_ENV]?.trim() ||
      process.env[API_KEY_ENV]?.trim() ||
      "";

    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of listeners) l(event);
    };

    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: Array<{ role: string; content: string }>,
      model: string,
      opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void },
    ): Promise<{ text: string; reasoning: string; usage: { input: number; output: number } | null }> => {
      const timeout = AbortSignal.timeout(180_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          stream: opts.stream,
          stream_options: opts.stream ? { include_usage: true } : undefined,
        }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Z.ai HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      if (!opts.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        return {
          text: typeof msg?.content === "string" ? msg.content : "",
          reasoning: typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "",
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
        };
      }

      // SSE streaming — identical to openai-compat.ts pattern.
      let text = "";
      let reasoning = "";
      let usage: { input: number; output: number } | null = null;
      if (!res.body) throw new Error("Z.ai returned no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") break readLoop;
            let chunk: any;
            try { chunk = JSON.parse(data); } catch { continue; }
            const delta = chunk.choices?.[0]?.delta;
            const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
            if (reasoningDelta) {
              reasoning += reasoningDelta;
              opts.onDelta?.(reasoningDelta, "reasoning_text");
            }
            const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
            if (contentDelta) {
              text += contentDelta;
              opts.onDelta?.(contentDelta, "assistant_text");
            }
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return { text, reasoning, usage };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no Z.ai key — paste it in Settings → Connections or set ${API_KEY_ENV}`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");

      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];

      appendNative(threadId, {
        dir: "out",
        source: "zai.chat.completions",
        msg: { model: turn.model ?? MODELS.default, messageCount: messages.length },
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? MODELS.default });

      (async () => {
        try {
          const { text, reasoning, usage } = await complete(messages, turn.model || MODELS.default, {
            stream: true,
            signal: abort.signal,
            onDelta: (delta, streamKind = "assistant_text") =>
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta }),
          });

          appendNative(threadId, {
            dir: "in",
            source: "zai.chat.completions",
            msg: { textLength: text.length, reasoningLength: reasoning.length, usage },
          });

          if (text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
          }
          if (usage) {
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          active.delete(threadId);
          const completed: RuntimeEvent = {
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
          };
          emit(usage ? { ...completed, usage } : completed);
        } catch (e) {
          active.delete(threadId);
          const error = e instanceof Error ? e : new Error(String(e));
          const aborted = error.name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: error.message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: "no Z.ai API key — paste it in Settings → Connections or set ZAI_API_KEY",
        };
      }
      return { state: "available", authenticated: true, version: null, billing: "subscription" };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async (): Promise<"unavailable"> => "unavailable",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { for (const { abort } of active.values()) abort.abort(); },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text, reasoning } = await complete([{ role: "user", content: prompt }], MODELS.default, { stream: false });
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
