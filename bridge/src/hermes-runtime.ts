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

export function createHermesBridgeRuntimeFromEngine(engine: HermesBotEngine): HermesBridgeRuntime {
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
    async send(payload) {
      const events: RuntimeEvent[] = [];
      const unsubscribe = engine.onEvent((event) => {
        events.push(event);
      });
      try {
        const result = await engine.send(payload);
        return {
          ok: true,
          turnId: result.turnId,
          events: scrubRuntimeEvents(events),
        };
      } catch (error) {
        return {
          ok: false,
          reason: failureCode(error),
          turnId: payload.turnId,
          events: scrubRuntimeEvents(events),
        };
      } finally {
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
    close: () => engine.close(),
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
      return createHermesBridgeRuntimeFromEngine(shared);
    },
  };
}
