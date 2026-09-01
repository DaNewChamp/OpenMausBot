import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfigPatch, parseStoredConfig } from "../config.ts";
import type { InstanceConfigMap, RuntimeEvent } from "../contracts.ts";
import type { HermesBotEngine, HermesBotEngineOptions } from "./hermes.ts";
import type {
  HermesBotBinding,
  HermesDiscovery,
} from "./contracts.ts";
import { createHermesEngineRegistry } from "./index.ts";

class FakeHermesEngine implements HermesBotEngine {
  readonly discover = vi.fn(async (): Promise<HermesDiscovery> => ({
    state: "available",
    version: "fixture",
    capabilities: {
      roster: true,
      canonicalChat: true,
      send: true,
      finalResponse: true,
      events: true,
      stop: true,
      routinesRead: false,
      messageAgent: false,
      groups: false,
      crossMachine: false,
      queueing: false,
      steer: false,
      attachments: false,
    },
    profiles: [{
      profile: "default",
      handle: "hermes",
      displayName: "Hermes",
      description: "fixture",
      canonicalChat: "present",
      availability: "available",
    }],
  }));
  readonly resolveCanonical = vi.fn(async () => ({
    profile: "default",
    title: "Bot Chat" as const,
    rootSessionId: "root",
    resolvedSessionId: "resolved",
    messageCount: 0,
  }));
  readonly send = vi.fn(async (input: { turnId: string }) => ({ turnId: input.turnId }));
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const binding: HermesBotBinding = {
  adapter: "hermesBot",
  profile: "default",
  canonicalTitle: "Bot Chat",
  bindingVersion: 1,
};

function providerRegistry(ids: string[]) {
  return {
    get: vi.fn((instanceId: string) => ids.includes(instanceId)
      ? ({ instanceId, driverKind: "hermesAgent" } as never)
      : null),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Hermes Bot Chat engine registry", () => {
  it("keeps Hermes metadata opt-in and rejects executable or secret fields", () => {
    const legacy = { vbot: { primaryEngine: "openmaus" as const } };
    expect(parseStoredConfig(legacy)).toEqual(legacy);
    expect(parseConfigPatch({ vbot: { hermes: { enabled: true, instanceId: "hermes" } } })).toEqual({
      vbot: { hermes: { enabled: true, instanceId: "hermes" } },
    });
    expect(() => parseConfigPatch({ vbot: { hermes: { enabled: true, HERMES_HOME: "/private" } } })).toThrow();
    expect(() => parseConfigPatch({ vbot: { hermes: { enabled: true, token: "secret" } } })).toThrow();
  });

  it("is disabled by default and starts no Hermes child", async () => {
    const createEngine = vi.fn((_options: HermesBotEngineOptions) => new FakeHermesEngine());
    const registry = createHermesEngineRegistry({
      instanceConfigs: { hermes: { driver: "hermesAgent" } },
      createEngine,
    });

    expect(registry.isEnabled).toBe(false);
    expect(createEngine).not.toHaveBeenCalled();
    await expect(registry.describe()).resolves.toMatchObject({
      state: "unavailable",
      instanceId: "hermes",
      profiles: [],
    });
    await registry.disposeAll();
  });

  it("discovers every configured Hermes runtime, forwards events, and cleans up listeners", async () => {
    const engines = new Map<string, FakeHermesEngine>();
    const createEngine = vi.fn((options: HermesBotEngineOptions) => {
      const engine = new FakeHermesEngine();
      engines.set(String(options.cli), engine);
      return engine;
    });
    const events: Array<{ event: RuntimeEvent; instanceId: string }> = [];
    const configs: InstanceConfigMap = {
      hermes: {
        driver: "hermesAgent",
        config: { cli: "/opt/hermes", workspace: "/private/workspace" },
        environment: {
          HERMES_HOME: "/private/hermes",
          HERMES_PROVIDER_TOKEN: "must-not-reach-factory",
        },
      },
      secondary: { driver: "hermesAgent", config: { cli: "/opt/hermes-secondary" } },
      ignored: { driver: "claudeAgent" },
    };
    const providers = providerRegistry(["hermes", "secondary"]);
    const registry = createHermesEngineRegistry({
      enabled: true,
      instanceConfigs: configs,
      providerRegistry: providers,
      createEngine,
      onEvent: (event, instanceId) => events.push({ event, instanceId }),
    });

    expect(createEngine).toHaveBeenCalledTimes(2);
    const firstOptions = createEngine.mock.calls[0]?.[0];
    expect(firstOptions).toMatchObject({ cli: "/opt/hermes", cwd: "/private/workspace" });
    expect(firstOptions?.environment).toMatchObject({ HERMES_HOME: "/private/hermes" });
    expect(firstOptions?.environment).not.toHaveProperty("HERMES_PROVIDER_TOKEN");

    await expect(registry.discover()).resolves.toMatchObject({
      state: "available",
      instanceId: "hermes",
      version: "fixture",
      profiles: [{ handle: "hermes" }],
    });
    expect(engines.get("/opt/hermes")?.discover).toHaveBeenCalledOnce();
    expect(engines.get("/opt/hermes-secondary")?.discover).toHaveBeenCalledOnce();

    const event: RuntimeEvent = {
      eventId: "event-1",
      provider: "hermesBot",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: new Date(0).toISOString(),
      type: "turn.started",
    };
    engines.get("/opt/hermes")?.emit(event);
    expect(events).toEqual([{ event, instanceId: "hermes" }]);

    expect(registry.forBinding(binding)).toBe(engines.get("/opt/hermes"));
    expect(registry.forBinding({ ...binding, canonicalTitle: "Other" as "Bot Chat" })).toBeNull();
    await registry.disposeAll();
    expect(engines.get("/opt/hermes")?.close).toHaveBeenCalledOnce();
    expect(engines.get("/opt/hermes-secondary")?.close).toHaveBeenCalledOnce();
    engines.get("/opt/hermes")?.emit(event);
    expect(events).toHaveLength(1);
    await expect(registry.describe()).resolves.toMatchObject({ state: "unavailable", profiles: [] });
  });

  it("requires a live Hermes provider instance and fails closed for invalid bindings", async () => {
    const createEngine = vi.fn((_options: HermesBotEngineOptions) => new FakeHermesEngine());
    const registry = createHermesEngineRegistry({
      enabled: true,
      instanceId: "missing",
      instanceConfigs: {
        hermes: { driver: "hermesAgent" },
        missing: { driver: "hermesAgent" },
      },
      providerRegistry: providerRegistry(["hermes"]),
      createEngine,
    });

    expect(createEngine).toHaveBeenCalledOnce();
    await expect(registry.discover()).resolves.toMatchObject({ state: "unavailable", reason: "state_unavailable" });
    expect(registry.forBinding(binding)).toBeNull();
    expect(registry.forBinding({ ...binding, adapter: "other" as "hermesBot" })).toBeNull();
    await registry.disposeAll();
  });
});
