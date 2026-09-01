import type { BindingStoreResult } from "./engines/bindings.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
} from "./engines/contracts.ts";

export type HermesInterruptRunOn = "maus" | "cloud";

export interface HermesInterruptEngine {
  interrupt(profile: string): Promise<void>;
}

export interface HermesInterruptRegistry {
  forBinding(binding: HermesBotBinding): HermesInterruptEngine | null;
}

export interface HermesInterruptProvider {
  adapter: {
    interruptTurn(threadId: string): Promise<void>;
  };
}

export interface HermesInterruptTarget {
  botId: string;
  threadId: string;
  runOn?: HermesInterruptRunOn;
}

export interface HermesInterruptDependencies {
  loadBindings: () => BindingStoreResult<ReadonlyMap<string, HermesBotBinding>>;
  hermesRegistry: HermesInterruptRegistry;
  resolveProvider: (target: HermesInterruptTarget) => HermesInterruptProvider | null;
}

export type HermesInterruptRoute = "hermes" | "provider" | "none";

/** Route every stop request through the hub-owned Hermes binding boundary.
 * A readable binding is authoritative: its adapter is used when available,
 * and a disabled/unavailable adapter fails closed. Only a readable sidecar
 * that proves the bot is unbound may select the normal provider adapter. */
export async function dispatchHermesInterrupt(
  target: HermesInterruptTarget,
  dependencies: HermesInterruptDependencies,
): Promise<HermesInterruptRoute> {
  const bindings = dependencies.loadBindings();
  if (bindings.state === "unavailable") throw new HermesEngineError(bindings.code);

  const binding = bindings.value.get(target.botId);
  if (binding) {
    const engine = dependencies.hermesRegistry.forBinding(binding);
    if (!engine) throw new HermesEngineError("state_unavailable");
    await engine.interrupt(binding.profile);
    return "hermes";
  }

  const provider = dependencies.resolveProvider(target);
  if (!provider) return "none";
  await provider.adapter.interruptTurn(target.threadId);
  return "provider";
}
