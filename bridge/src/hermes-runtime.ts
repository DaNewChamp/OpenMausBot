import type { RuntimeEvent } from "../../server/contracts.ts";
import { createHermesBotEngine, type HermesBotEngine } from "../../server/engines/hermes.ts";
import { HermesEngineError, type HermesFailureCode } from "../../server/engines/contracts.ts";
import {
  projectHermesDiscoveryWire,
  scrubRuntimeEvents,
} from "../../shared/bridge-hermes-contract.ts";
import type { HermesBridgeRuntime, HermesBridgeRuntimeFactory } from "./hermes.ts";

const TERMINAL_EVENT_TYPES = new Set(["turn.completed", "runtime.error"]);

function failureCode(error: unknown): HermesFailureCode {
  return error instanceof HermesEngineError ? error.code : "upstream_error";
}

function isTerminalEvent(event: RuntimeEvent, turnId: string): boolean {
  return event.turnId === turnId && TERMINAL_EVENT_TYPES.has(event.type);
}

function terminalFromEvents(events: readonly RuntimeEvent[], turnId: string): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isTerminalEvent(event, turnId)) return event;
  }
  return undefined;
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
      let resolveTerminal: (() => void) | undefined;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      const unsubscribe = engine.onEvent((event) => {
        events.push(event);
        if (isTerminalEvent(event, payload.turnId)) resolveTerminal?.();
      });
      let removeAbortListener: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<"aborted">((resolve) => {
          const onAbort = () => {
            void engine.interrupt(payload.profile, payload.turnId).catch(() => {});
            resolve("aborted");
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        })
        : undefined;
      const aborted = () => signal?.aborted === true;
      const abortResult = () => ({
        ok: false as const,
        reason: "upstream_error" as const,
        turnId: payload.turnId,
        events: scrubRuntimeEvents(events),
      });
      const sendResultFromTerminal = () => {
        const terminal = terminalFromEvents(events, payload.turnId);
        if (terminal?.type === "runtime.error") return abortResult();
        if (terminal?.type === "turn.completed" && terminal.ok === false) return abortResult();
        return {
          ok: true as const,
          turnId: payload.turnId,
          events: scrubRuntimeEvents(events),
        };
      };
      const waitForTerminal = async (): Promise<void> => {
        if (terminalFromEvents(events, payload.turnId)) return;
        if (abortPromise) {
          const raced = await Promise.race([terminalPromise, abortPromise]);
          if (raced === "aborted") return;
          return;
        }
        await terminalPromise;
      };
      try {
        if (abortPromise) {
          const raced = await Promise.race([engine.send(payload), abortPromise]);
          if (raced === "aborted" || aborted()) return abortResult();
        } else {
          await engine.send(payload);
        }
        if (aborted()) return abortResult();
        await waitForTerminal();
        if (aborted()) return abortResult();
        return sendResultFromTerminal();
      } catch (error) {
        if (aborted() || (error instanceof Error && error.message === "aborted")) {
          return abortResult();
        }
        await waitForTerminal();
        if (terminalFromEvents(events, payload.turnId)) {
          return sendResultFromTerminal();
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
