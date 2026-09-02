import type { BridgeRegistry } from "./bridge-registry.ts";
import { loadHermesBridgeBindings } from "./bridge-hermes-bindings.ts";
import type { BindingStoreResult } from "./engines/bindings.ts";
import {
  HermesEngineError,
  type HermesBotBinding,
} from "./engines/contracts.ts";
import type { HermesBridgeBinding } from "../shared/bridge-hermes-contract.ts";
import {
  bridgeBindingUnavailableError,
  dispatchHermesBridgeInterrupt,
  resolveHermesBotDispatch,
} from "./hermes-bridge-integration.ts";

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
  mightBeBridgeBound?: (botId: string) => boolean;
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
  const resolution = resolveHermesBotDispatch(target.botId, {
    localBindings: dependencies.loadBindings(),
    bridgeBindings: (dependencies.loadBridgeBindings ?? loadHermesBridgeBindings)(),
    bridgeCandidate: dependencies.mightBeBridgeBound?.(target.botId) ?? false,
  });

  if (resolution.route === "local-unavailable" || resolution.route === "bridge-unavailable") {
    throw new HermesEngineError(resolution.code);
  }
  if (resolution.route === "local") {
    const engine = dependencies.hermesRegistry.forBinding(resolution.binding);
    if (!engine) throw new HermesEngineError("state_unavailable");
    await engine.interrupt(resolution.binding.profile);
    return "hermes";
  }
  if (resolution.route === "bridge") {
    await interruptBridgeBinding(resolution.binding, dependencies);
    return "hermes-bridge";
  }

  const provider = dependencies.resolveProvider(target);
  if (!provider) return "none";
  await provider.adapter.interruptTurn(target.threadId);
  return "provider";
}
