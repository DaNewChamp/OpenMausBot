import { describe, expect, it, vi } from "vitest";

import type { HermesBotBinding, HermesCanonicalChat } from "./engines/contracts.ts";
import type { HermesEngineDescription } from "./engines/index.ts";
import type { HermesBotEngine } from "./engines/hermes.ts";
import {
  connectHermesProfile,
  projectHermesSetupStatus,
  type HermesSetupRegistry,
  type ConnectHermesProfileOptions,
  type HermesSetupProfile,
} from "./hermes-setup.ts";

const capabilities = {
  roster: true,
  canonicalChat: false,
  send: false,
  finalResponse: false,
  events: true,
  stop: false,
  routinesRead: false,
  messageAgent: false,
  groups: false,
  crossMachine: false,
  queueing: false,
  steer: false,
  attachments: false,
  adoptMint: false,
  approvals: false,
  exclusiveSubmit: false,
};

const description = (overrides: Partial<HermesEngineDescription> = {}): HermesEngineDescription => ({
  state: "available",
  instanceId: "hermes",
  capabilities,
  profiles: [{
    profile: "default",
    handle: "hermes",
    displayName: "Hermes",
    description: "Local assistant",
    model: "sonnet",
    provider: "anthropic",
    canonicalChat: "absent",
    availability: "available",
  }],
  ...overrides,
});

const canonical: HermesCanonicalChat = {
  profile: "default",
  title: "Bot Chat",
  rootSessionId: "root",
  resolvedSessionId: "tip",
  messageCount: 0,
};

function fakeRegistry(engine: { ensureCanonical: (profile: string) => Promise<HermesCanonicalChat> }): HermesSetupRegistry {
  // SAFETY: this fake only exercises setup's optional ensureCanonical seam;
  // the production registry supplies the complete HermesBotEngine contract.
  return {
    isEnabled: true,
    instanceId: "hermes",
    discover: vi.fn(async () => description()),
    describe: vi.fn(async () => description()),
    forBinding: vi.fn((_binding: HermesBotBinding) => engine as HermesBotEngine),
  };
}

describe("Hermes setup projection", () => {
  it("keeps disabled and unavailable state free of bot/session details", () => {
    const bindings = { state: "available" as const, value: new Map() };
    expect(projectHermesSetupStatus({
      enabled: false,
      description: description({ instanceId: "hermes" }),
      bindings,
      botExists: () => false,
    })).toMatchObject({ state: "disabled", profiles: [], capabilities: expect.objectContaining({ roster: false }) });

    expect(projectHermesSetupStatus({
      enabled: true,
      description: description({ state: "unavailable", reason: "missing_cli", profiles: [] }),
      bindings,
      botExists: () => false,
    })).toMatchObject({ state: "unavailable", reason: "missing_cli", profiles: [] });
  });

  it("projects ready remote bridge profiles when local Hermes is disabled", () => {
    const remoteProfile: HermesSetupProfile = {
      profile: "default",
      handle: "hermes",
      displayName: "Hermes",
      description: "Remote assistant",
      canonicalChat: "absent",
      availability: "available",
      placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
    };
    const status = projectHermesSetupStatus({
      enabled: false,
      description: description({ state: "unavailable", profiles: [] }),
      bindings: { state: "available", value: new Map() },
      remoteProfiles: [remoteProfile],
      remoteCapabilities: { ...capabilities, send: true, events: true },
      botExists: () => false,
    });
    expect(status).toMatchObject({
      state: "ready",
      profiles: [remoteProfile],
      capabilities: {
        roster: true,
        canonicalChat: false,
        send: false,
        events: false,
      },
    });
  });

  it("marks only a valid existing binding as connected", () => {
    const binding: HermesBotBinding = {
      adapter: "hermesBot",
      profile: "default",
      canonicalTitle: "Bot Chat",
      bindingVersion: 1,
    };
    const status = projectHermesSetupStatus({
      enabled: true,
      description: description(),
      bindings: { state: "available", value: new Map([["bot-1", binding]]) },
      botExists: (id) => id === "bot-1",
      localComputerName: "Vincent’s Mac",
    });
    expect(status).toMatchObject({ state: "connected", capabilities: { canonicalChat: false } });
    expect(status.profiles).toEqual([expect.objectContaining({
      profile: "default",
      botId: "bot-1",
      canonicalChat: "absent",
      authStatus: "connected",
      endpoint: expect.objectContaining({
        id: "local:hub:default",
        computerName: "Vincent’s Mac",
        label: "Vincent’s Mac · Hermes",
      }),
    })]);
    expect(JSON.stringify(status)).not.toMatch(/root|resolved|session|sk-|Bearer |HERMES_HOME/i);
  });

  it("projects sign-in required when local Hermes has no provider credentials", () => {
    const status = projectHermesSetupStatus({
      enabled: true,
      description: description({ state: "unavailable", reason: "invalid_credentials", profiles: [] }),
      bindings: { state: "available", value: new Map() },
      botExists: () => false,
      localComputerName: "Studio",
    });
    expect(status.state).toBe("unavailable");
    expect(status.reason).toBe("invalid_credentials");
    expect(status.profiles).toEqual([expect.objectContaining({
      profile: "default",
      authStatus: "signInRequired",
      endpoint: expect.objectContaining({
        computerName: "Studio",
        label: "Studio · Hermes",
      }),
    })]);
  });

  it("does not infer canonical support from a binding when discovery has no canonical proof", () => {
    const binding: HermesBotBinding = {
      adapter: "hermesBot",
      profile: "default",
      canonicalTitle: "Bot Chat",
      bindingVersion: 1,
    };
    const status = projectHermesSetupStatus({
      enabled: true,
      description: description({ capabilities: { ...capabilities, canonicalChat: true } }),
      bindings: { state: "available", value: new Map([["bot-1", binding]]) },
      botExists: (id) => id === "bot-1",
    });
    expect(status.state).toBe("connected");
    expect(status.capabilities.canonicalChat).toBe(false);
    expect(status.profiles[0]).toMatchObject({ botId: "bot-1", canonicalChat: "absent" });
  });

  it("fails closed on a stale binding instead of minting another bot", () => {
    const binding: HermesBotBinding = {
      adapter: "hermesBot",
      profile: "default",
      canonicalTitle: "Bot Chat",
      bindingVersion: 1,
    };
    expect(projectHermesSetupStatus({
      enabled: true,
      description: description(),
      bindings: { state: "available", value: new Map([["missing-bot", binding]]) },
      botExists: () => false,
    })).toMatchObject({ state: "unavailable", reason: "state_unavailable" });
  });
});

describe("Hermes profile connect", () => {
  it("creates one quiet bot and binding, then reuses both on repeat", async () => {
    const ensureCanonical = vi.fn(async () => canonical);
    const registry = fakeRegistry({ ensureCanonical });
    const bots = new Map<string, { id: string }>();
    let bindings = new Map<string, HermesBotBinding>();
    let nextId = 0;
    const createBot = vi.fn(() => {
      const bot = { id: `bot-${++nextId}` };
      bots.set(bot.id, bot);
      return bot;
    });
    const result1 = await connectHermesProfile({
      registry,
      profile: undefined,
      loadBindings: () => ({ state: "available", value: bindings }),
      setBinding: (id, binding) => {
        bindings = new Map(bindings).set(id, binding);
        return { state: "available", value: undefined };
      },
      deleteBot: (id) => bots.delete(id),
      bot: (id) => bots.get(id) ?? null,
      createBot,
    });
    const result2 = await connectHermesProfile({
      registry,
      profile: "hermes",
      loadBindings: () => ({ state: "available", value: bindings }),
      setBinding: (id, binding) => {
        bindings = new Map(bindings).set(id, binding);
        return { state: "available", value: undefined };
      },
      deleteBot: (id) => bots.delete(id),
      bot: (id) => bots.get(id) ?? null,
      createBot,
    });
    expect(result1.botId).toBe("bot-1");
    expect(result2.botId).toBe("bot-1");
    expect(createBot).toHaveBeenCalledTimes(1);
    expect(ensureCanonical).toHaveBeenCalledTimes(2);
    expect(result1.profile).toMatchObject({ profile: "default", botId: "bot-1" });
  });

  it("serializes concurrent imports so one profile still gets one bot", async () => {
    const ensureCanonical = vi.fn(async () => canonical);
    const registry = fakeRegistry({ ensureCanonical });
    const bots = new Map<string, { id: string }>();
    let bindings = new Map<string, HermesBotBinding>();
    let nextId = 0;
    const createBot = vi.fn(() => {
      const bot = { id: `bot-${++nextId}` };
      bots.set(bot.id, bot);
      return bot;
    });
    const options = (): ConnectHermesProfileOptions => ({
      registry,
      profile: "default",
      loadBindings: () => ({ state: "available" as const, value: bindings }),
      setBinding: (id: string, binding: HermesBotBinding) => {
        bindings = new Map(bindings).set(id, binding);
        return { state: "available" as const, value: undefined };
      },
      deleteBot: (id: string) => bots.delete(id),
      bot: (id: string) => bots.get(id) ?? null,
      createBot,
    });
    const [first, second] = await Promise.all([
      connectHermesProfile(options()),
      connectHermesProfile(options()),
    ]);
    expect(first.botId).toBe("bot-1");
    expect(second.botId).toBe("bot-1");
    expect(createBot).toHaveBeenCalledTimes(1);
  });

  it("deletes a newly-created bot when the binding cannot be persisted", async () => {
    const registry = fakeRegistry({ ensureCanonical: vi.fn(async () => canonical) });
    const deleteBot = vi.fn(() => true);
    const createBot = vi.fn(() => ({ id: "bot-orphan" }));
    await expect(connectHermesProfile({
      registry,
      profile: "default",
      loadBindings: () => ({ state: "available", value: new Map() }),
      setBinding: () => ({ state: "unavailable", code: "state_unavailable", message: "Hermes state is unavailable" }),
      deleteBot,
      bot: () => null,
      createBot,
    })).rejects.toMatchObject({ code: "state_unavailable" });
    expect(deleteBot).toHaveBeenCalledWith("bot-orphan");
  });

  it("does not hide a rollback delete failure when the newly-created bot remains", async () => {
    const registry = fakeRegistry({ ensureCanonical: vi.fn(async () => canonical) });
    const bots = new Map<string, { id: string }>();
    const deleteBot = vi.fn(() => false);
    const createBot = vi.fn(() => {
      const bot = { id: "bot-stuck" };
      bots.set(bot.id, bot);
      return bot;
    });
    await expect(connectHermesProfile({
      registry,
      profile: "default",
      loadBindings: () => ({ state: "available", value: new Map() }),
      setBinding: () => ({ state: "unavailable", code: "state_unavailable", message: "Hermes state is unavailable" }),
      deleteBot,
      bot: (id) => bots.get(id) ?? null,
      createBot,
    })).rejects.toMatchObject({ code: "state_unavailable" });
    expect(deleteBot).toHaveBeenCalledWith("bot-stuck");
    expect(bots.has("bot-stuck")).toBe(true);
  });

  it("rebinds an existing Hermes bot to another local profile without minting a new bot", async () => {
    const ensureCanonical = vi.fn(async () => canonical);
    const registry: HermesSetupRegistry = {
      isEnabled: true,
      instanceId: "hermes",
      discover: vi.fn(async () => description({
        profiles: [
          {
            profile: "default",
            handle: "hermes",
            displayName: "Hermes",
            description: "Local assistant",
            model: "sonnet",
            provider: "anthropic",
            canonicalChat: "present",
            availability: "available",
          },
          {
            profile: "work",
            handle: "work",
            displayName: "Work",
            description: "Work profile",
            model: "sonnet",
            provider: "anthropic",
            canonicalChat: "absent",
            availability: "available",
          },
        ],
      })),
      describe: vi.fn(async () => description()),
      forBinding: vi.fn((_binding: HermesBotBinding) => ({
        ensureCanonical,
      }) as unknown as HermesBotEngine),
    };
    const bots = new Map<string, { id: string }>([["bot-keep", { id: "bot-keep" }]]);
    let bindings = new Map<string, HermesBotBinding>([[
      "bot-keep",
      { adapter: "hermesBot", profile: "default", canonicalTitle: "Bot Chat", bindingVersion: 1 },
    ]]);
    const createBot = vi.fn(() => {
      throw new Error("must not mint another bot");
    });
    const result = await connectHermesProfile({
      registry,
      botId: "bot-keep",
      placement: { kind: "local", profile: "work" },
      loadBindings: () => ({ state: "available", value: bindings }),
      setBinding: (id, binding) => {
        bindings = new Map(bindings).set(id, binding);
        return { state: "available", value: undefined };
      },
      removeBinding: (id) => {
        const next = new Map(bindings);
        next.delete(id);
        bindings = next;
        return { state: "available", value: undefined };
      },
      deleteBot: () => false,
      bot: (id) => bots.get(id) ?? null,
      createBot,
    });
    expect(result.botId).toBe("bot-keep");
    expect(result.created).toBe(false);
    expect(bindings.get("bot-keep")).toMatchObject({ profile: "work" });
    expect(createBot).not.toHaveBeenCalled();
    expect(ensureCanonical).toHaveBeenCalledWith("work");
  });

  it("does not rebind a bot that is not already Hermes-bound", async () => {
    const registry = fakeRegistry({ ensureCanonical: vi.fn(async () => canonical) });
    await expect(connectHermesProfile({
      registry,
      botId: "plain-bot",
      placement: { kind: "local", profile: "default" },
      loadBindings: () => ({ state: "available", value: new Map() }),
      setBinding: () => ({ state: "available", value: undefined }),
      deleteBot: () => false,
      bot: (id) => id === "plain-bot" ? { id } : null,
      createBot: () => {
        throw new Error("must not mint another bot");
      },
    })).rejects.toMatchObject({ code: "state_unavailable" });
  });

  it("does not steal a profile already bound to another Hermes bot", async () => {
    const registry = fakeRegistry({ ensureCanonical: vi.fn(async () => canonical) });
    const bots = new Map<string, { id: string }>([
      ["bot-keep", { id: "bot-keep" }],
      ["bot-other", { id: "bot-other" }],
    ]);
    const bindings = new Map<string, HermesBotBinding>([
      ["bot-keep", { adapter: "hermesBot", profile: "default", canonicalTitle: "Bot Chat", bindingVersion: 1 }],
      ["bot-other", { adapter: "hermesBot", profile: "work", canonicalTitle: "Bot Chat", bindingVersion: 1 }],
    ]);
    await expect(connectHermesProfile({
      registry: {
        ...registry,
        discover: vi.fn(async () => description({
          profiles: [
            {
              profile: "default",
              handle: "hermes",
              displayName: "Hermes",
              description: "Local assistant",
              model: "sonnet",
              provider: "anthropic",
              canonicalChat: "present",
              availability: "available",
            },
            {
              profile: "work",
              handle: "work",
              displayName: "Work",
              description: "Work profile",
              model: "sonnet",
              provider: "anthropic",
              canonicalChat: "absent",
              availability: "available",
            },
          ],
        })),
      },
      botId: "bot-keep",
      placement: { kind: "local", profile: "work" },
      loadBindings: () => ({ state: "available", value: bindings }),
      setBinding: () => ({ state: "available", value: undefined }),
      deleteBot: () => false,
      bot: (id) => bots.get(id) ?? null,
      createBot: () => {
        throw new Error("must not mint another bot");
      },
    })).rejects.toMatchObject({ code: "profile_unavailable" });
    expect(bindings.get("bot-keep")).toMatchObject({ profile: "default" });
    expect(bindings.get("bot-other")).toMatchObject({ profile: "work" });
  });
});
