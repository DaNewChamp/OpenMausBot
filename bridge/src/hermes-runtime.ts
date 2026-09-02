import type { RuntimeEvent } from "../../server/contracts.ts";
import { createHermesBotEngine, type HermesBotEngine } from "../../server/engines/hermes.ts";
import { HermesEngineError, type HermesFailureCode } from "../../server/engines/contracts.ts";
import {
  projectHermesDiscoveryWire,
  scrubRuntimeEvents,
} from "../../shared/bridge-hermes-contract.ts";
import type { HermesBridgeRuntime, HermesBridgeRuntimeFactory } from "./hermes.ts";

function failureCode(error: unknown): HermesFailureCode {
  return error instanceof HermesEngineError ? error.code : "upstream_error";
}

export function createHermesBridgeRuntimeFromEngine(
  engine: HermesBotEngine,
  options: { closeOnDispose?: boolean } = {},
): HermesBridgeRuntime {
  const closeOnDispose = options.closeOnDispose ?? false;
  return {
    async discover() {
      return projectHermesDiscoveryWire(await engine.discover());
    },
    async ensureCanonical(profile) {
      if (engine.ensureCanonical) {
        try {
          await engine.ensureCanonical(profile);
          return { state: "present", adopted: true };
        } catch (error) {
          try {
            await engine.resolveCanonical(profile);
            return { state: "present" };
          } catch {
            return { state: "unknown", reason: failureCode(error) };
          }
        }
      }
      try {
        await engine.resolveCanonical(profile);
        return { state: "present" };
      } catch (error) {
        return { state: "unknown", reason: failureCode(error) };
      }
    },
    async send(payload, signal?: AbortSignal) {
      if (signal?.aborted) {
        return {
          ok: false,
          reason: "upstream_error" as const,
          turnId: payload.turnId,
          events: [],
        };
      }
      const events: RuntimeEvent[] = [];
      const unsubscribe = engine.onEvent((event) => {
        events.push(event);
      });
      let removeAbortListener: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
          const onAbort = () => {
            void engine.interrupt(payload.profile, payload.turnId).catch(() => {});
            reject(new Error("aborted"));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        })
        : undefined;
      try {
        const result = await (abortPromise
          ? Promise.race([engine.send(payload), abortPromise])
          : engine.send(payload));
        if (signal?.aborted) {
          return {
            ok: false,
            reason: "upstream_error" as const,
            turnId: payload.turnId,
            events: scrubRuntimeEvents(events),
          };
        }
        return {
          ok: true,
          turnId: result.turnId,
          events: scrubRuntimeEvents(events),
        };
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.message === "aborted")) {
          return {
            ok: false,
            reason: "upstream_error" as const,
            turnId: payload.turnId,
            events: scrubRuntimeEvents(events),
          };
        }
        return {
          ok: false,
          reason: failureCode(error),
          turnId: payload.turnId,
          events: scrubRuntimeEvents(events),
        };
      } finally {
        removeAbortListener?.();
        unsubscribe();
      }
    },
    async interrupt(payload) {
      try {
        await engine.interrupt(payload.profile, payload.turnId);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: failureCode(error) };
      }
    },
    close: async () => {
      if (closeOnDispose) engine.close();
    },
  };
}

export function defaultHermesBridgeRuntimeFactory(): HermesBridgeRuntimeFactory {
  let shared: HermesBotEngine | null = null;
  return {
    async create() {
      if (!shared) {
        shared = createHermesBotEngine({
          cli: process.env.OMB_BRIDGE_HERMES_CLI ?? "hermes",
        });
      }
      return createHermesBridgeRuntimeFromEngine(shared, { closeOnDispose: false });
    },
  };
}
