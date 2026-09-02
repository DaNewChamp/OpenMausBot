import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

const localHermes = {
  kind: "hermes" as const,
  placement: { kind: "local" as const, profile: "coder" },
  bindingVersion: 2 as const,
};

const providerClaude = {
  kind: "provider" as const,
  instanceId: "claude",
  model: "claude-sonnet-5",
};

describe("approved runtime conversion", () => {
  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const { resetRememberedHermesEndpointsForTests } = await import("./bot-runtime-rebind.ts");
    resetRememberedHermesEndpointsForTests();
  });
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("applies a direct-user conversion immediately", async () => {
    const { requestBotRuntimeRebind, rememberHermesEndpoint, resolveBotRuntimeBinding } = await import(
      "./bot-runtime-rebind.ts"
    );
    rememberHermesEndpoint("local:coder", "rev-1");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist" });
    const result = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: localHermes,
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(result).toMatchObject({ status: "applied" });
    if (result.status !== "applied") return;
    expect(result.bot.id).toBe(bot.id);
    expect(result.bot.name).toBe("Specialist");
    expect(result.summary).toMatch(/Specialist/);
    expect(result.summary).toMatch(/Claude|claude/i);
    expect(result.summary).toMatch(/coder/);
    expect(result.summary).not.toMatch(/token|\/Users\/|session-/i);
    expect(resolveBotRuntimeBinding(store.bot(bot.id)!)).toEqual({ state: "available", value: localHermes });
  });

  it("returns a pending approval for a Hermes-initiated conversion", async () => {
    const { requestBotRuntimeRebind, resolveRuntimeRebind, rememberHermesEndpoint, resolveBotRuntimeBinding } =
      await import("./bot-runtime-rebind.ts");
    rememberHermesEndpoint("local:coder", "rev-1");
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief" });
    const bot = store.createBot({ name: "Specialist" });
    const bus: ApprovalBus = { store, broadcast: () => {} };
    const result = await requestBotRuntimeRebind({
      store,
      approval: bus,
      actor: chief,
      request: {
        targetBotId: bot.id,
        binding: localHermes,
        contextMode: "none",
        userRequested: false,
      },
    });
    expect(result).toMatchObject({ status: "pending_approval" });
    if (result.status !== "pending_approval") return;
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.summary).not.toMatch(/token|HERMES_HOME|\/Users\//i);
    expect(resolveBotRuntimeBinding(store.bot(bot.id)!)).toEqual({
      state: "available",
      value: providerClaude,
    });
    const card = store
      .messagesFor(chief.threadId)
      .find((message) => message.kind === "options" && message.card?.requestId === result.requestId);
    expect(card?.card?.requestId).toBe(result.requestId);
    expect(card?.card?.title).toMatch(/approval/i);
    expect(JSON.stringify(card)).not.toMatch(/token|sk-ant|HERMES_HOME/i);
    expect(resolveRuntimeRebind(bus, result.requestId, "allow")).toBe(true);
    expect(resolveBotRuntimeBinding(store.bot(bot.id)!)).toEqual({ state: "available", value: localHermes });
  });

  it("rejects approval when the binding fingerprint no longer matches", async () => {
    const { requestBotRuntimeRebind, resolveRuntimeRebind, rememberHermesEndpoint, resolveBotRuntimeBinding } =
      await import("./bot-runtime-rebind.ts");
    rememberHermesEndpoint("local:coder", "rev-1");
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief" });
    const bot = store.createBot({ name: "Specialist" });
    const bus: ApprovalBus = { store, broadcast: () => {} };
    const result = await requestBotRuntimeRebind({
      store,
      approval: bus,
      actor: chief,
      request: {
        targetBotId: bot.id,
        binding: localHermes,
        contextMode: "none",
        userRequested: false,
      },
    });
    expect(result.status).toBe("pending_approval");
    if (result.status !== "pending_approval") return;
    const tampered = `${result.requestId}-tampered`;
    expect(resolveRuntimeRebind(bus, tampered, "allow")).toBe(false);
    expect(resolveBotRuntimeBinding(store.bot(bot.id)!)).toEqual({
      state: "available",
      value: providerClaude,
    });
  });

  it("rejects stale target state at apply time", async () => {
    const { requestBotRuntimeRebind, rememberHermesEndpoint } = await import("./bot-runtime-rebind.ts");
    rememberHermesEndpoint("local:coder", "rev-1");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist" });
    store.setActivity(bot.id, "working");
    const result = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: localHermes,
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(result).toMatchObject({ status: "error", code: "bot_active" });
    if (result.status === "error") {
      expect(JSON.stringify(result)).not.toMatch(/token|\/Users\/|HERMES_HOME/i);
    }
  });

  it("rejects an unknown bridge or profile without leaking endpoint diagnostics", async () => {
    const { requestBotRuntimeRebind, rememberHermesEndpoint } = await import("./bot-runtime-rebind.ts");
    rememberHermesEndpoint("local:coder", "rev-1");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist" });
    const result = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: {
          kind: "hermes",
          placement: { kind: "bridge", bridgeId: "missing-bridge", profile: "ghost" },
          bindingVersion: 2,
        },
        contextMode: "none",
        userRequested: true,
      },
      endpointError: "Failed to read /Users/vincent/.hermes/token and HERMES_HOME=/secret",
    });
    expect(result).toMatchObject({ status: "error", code: "endpoint_unavailable" });
    if (result.status !== "error") return;
    expect(result.message).not.toMatch(/\/Users\/vincent|\.hermes\/token|HERMES_HOME=\/secret/i);
    expect(JSON.stringify(result)).not.toMatch(/\/Users\/vincent|HERMES_HOME=\/secret/i);
  });

  it("reverses a converted bot back to its provider runtime", async () => {
    const { requestBotRuntimeRebind, rememberHermesEndpoint, resolveBotRuntimeBinding } = await import(
      "./bot-runtime-rebind.ts"
    );
    rememberHermesEndpoint("local:coder", "rev-1");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist", modelSelection: selection() });
    const converted = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: localHermes,
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(converted.status).toBe("applied");
    const reversed = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: providerClaude,
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(reversed).toMatchObject({ status: "applied" });
    expect(resolveBotRuntimeBinding(store.bot(bot.id)!)).toEqual({
      state: "available",
      value: providerClaude,
    });
    expect(store.bot(bot.id)?.modelSelection).toEqual(selection());
  });

  it("applies live convert for iOS display-name ids and canonical discovery ids without minting a bot", async () => {
    const {
      requestBotRuntimeRebind,
      rememberHermesEndpoint,
      rememberHermesBridgeAlias,
      resolveBotRuntimeBinding,
    } = await import("./bot-runtime-rebind.ts");
    rememberHermesEndpoint("bridge:bridge-mini:default", "rev-bridge-1");
    rememberHermesBridgeAlias("Mac mini", "bridge-mini");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist" });
    const fromIos = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: {
          kind: "hermes",
          placement: { kind: "bridge", bridgeId: "mac mini", profile: "default" },
          bindingVersion: 2,
        },
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(fromIos).toMatchObject({ status: "applied" });
    if (fromIos.status !== "applied") return;
    expect(fromIos.bot.id).toBe(bot.id);
    expect(store.bots.filter((row) => row.name === "Specialist")).toHaveLength(1);
    expect(fromIos.bot.runtimeBinding).toEqual({
      kind: "hermes",
      placement: { kind: "bridge", bridgeId: "bridge-mini", profile: "default" },
      bindingVersion: 2,
    });
    expect(resolveBotRuntimeBinding(store.bot(bot.id)!)).toEqual({
      state: "available",
      value: {
        kind: "hermes",
        placement: { kind: "bridge", bridgeId: "bridge-mini", profile: "default" },
        bindingVersion: 2,
      },
    });

    const reversed = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: providerClaude,
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(reversed.status).toBe("applied");
    const fromCanonical = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: {
          kind: "hermes",
          placement: { kind: "bridge", bridgeId: "bridge-mini", profile: "default" },
          bindingVersion: 2,
        },
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(fromCanonical).toMatchObject({ status: "applied" });
    if (fromCanonical.status !== "applied") return;
    expect(fromCanonical.bot.id).toBe(bot.id);
    expect(fromCanonical.bot.runtimeBinding).toEqual({
      kind: "hermes",
      placement: { kind: "bridge", bridgeId: "bridge-mini", profile: "default" },
      bindingVersion: 2,
    });
  });

  it("resolves convert-to-Hermes on this computer from local:{profile} discovery", async () => {
    const { requestBotRuntimeRebind, rememberLocalHermesProfiles, lookupHermesEndpoint } = await import(
      "./bot-runtime-rebind.ts"
    );
    rememberLocalHermesProfiles(
      [{ profile: "coder", availability: "available" }],
      "rev-local-1",
    );
    expect(lookupHermesEndpoint(localHermes)).toEqual({
      state: "available",
      endpointId: "local:coder",
      capabilityRevision: "rev-local-1",
    });
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist" });
    const result = await requestBotRuntimeRebind({
      store,
      request: {
        targetBotId: bot.id,
        binding: localHermes,
        contextMode: "none",
        userRequested: true,
      },
    });
    expect(result).toMatchObject({ status: "applied" });
    if (result.status !== "applied") return;
    expect(result.bot.runtimeBinding).toEqual(localHermes);
  });
});
