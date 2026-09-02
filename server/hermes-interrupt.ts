import type { BridgeRegistry } from "./bridge-registry.ts";
import { loadHermesBridgeBindings } from "./bridge-hermes-bindings.ts";
import type { BindingStoreResult } from "./engines/bindings.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
} from "./engines/contracts.ts";
import type { HermesBridgeBinding } from "../shared/bridge-hermes-contract.ts";
import { bridgeBindingUnavailableError, dispatchHermesBridgeInterrupt } from "./hermes-bridge-integration.ts";

export type HermesInterruptRunOn = "maus" | "cloud";

export interface HermesInterruptEngine {
  interrupt(profile: string, turnId?: string): Promise<void>;
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
  loadBridgeBindings?: () => ReturnType<typeof loadHermesBridgeBindings>;
  bridgeRegistry?: BridgeRegistry;
  hermesRegistry: HermesInterruptRegistry;
  resolveProvider: (target: HermesInterruptTarget) => HermesInterruptProvider | null;
}

export type HermesInterruptRoute = "hermes" | "hermes-bridge" | "provider" | "none";

async function interruptBridgeBinding(
  binding: HermesBridgeBinding,
  dependencies: HermesInterruptDependencies,
): Promise<void> {
  if (!dependencies.bridgeRegistry) throw new HermesEngineError("gateway_unavailable");
  try {
    await dispatchHermesBridgeInterrupt(dependencies.bridgeRegistry, binding);
  } catch (error) {
    throw bridgeBindingUnavailableError(error);
  }
}

/** Route every stop request through the hub-owned Hermes binding boundary.
 * A readable binding is authoritative: its adapter is used when available,
 * and a disabled/unavailable adapter fails closed. Only a readable sidecar
 * that proves the bot is unbound may select the normal provider adapter. */
export async function dispatchHermesInterrupt(
  target: HermesInterruptTarget,
  dependencies: HermesInterruptDependencies,
): Promise<HermesInterruptRoute> {
  const bridgeBindings = (dependencies.loadBridgeBindings ?? loadHermesBridgeBindings)();
  if (bridgeBindings.state === "unavailable") throw new HermesEngineError(bridgeBindings.code);

  const bridgeBinding = bridgeBindings.value.get(target.botId);
  if (bridgeBinding) {
    await interruptBridgeBinding(bridgeBinding, dependencies);
    return "hermes-bridge";
  }

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
