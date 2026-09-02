import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { setHermesBridgeBinding } from "./bridge-hermes-bindings.ts";
import { loadHermesBindings, setHermesBinding } from "./engines/bindings.ts";
import type { HermesBotBinding } from "./engines/contracts.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

const localHermes = {
  kind: "hermes" as const,
  placement: { kind: "local" as const, profile: "coder" },
  bindingVersion: 2 as const,
};

const bridgeHermes = {
  kind: "hermes" as const,
  placement: { kind: "bridge" as const, bridgeId: "bridge-mini", profile: "research" },
  bindingVersion: 2 as const,
};

const providerClaude = {
  kind: "provider" as const,
  instanceId: "claude",
  model: "claude-sonnet-5",
};

const v1Binding: HermesBotBinding = {
  adapter: "hermesBot",
  profile: "coder",
  canonicalTitle: "Bot Chat",
  bindingVersion: 1,
};

describe("bot runtime binding domain", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("normalizes a provider bot from modelSelection without Hermes sidecars", async () => {
    const { resolveBotRuntimeBinding } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief", modelSelection: selection() });
    const resolved = resolveBotRuntimeBinding(bot);
    expect(resolved).toEqual({ state: "available", value: providerClaude });
  });

  it("normalizes a legacy local Hermes sidecar to bindingVersion 2 at read time only", async () => {
    const { resolveBotRuntimeBinding, normalizeLegacyHermesBinding } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "HermesChief" });
    expect(setHermesBinding(bot.id, v1Binding)).toEqual({ state: "available", value: undefined });
    const before = readFileSync(join(DATA_DIR, "hermes-bindings.json"));
    expect(JSON.parse(before.toString("utf8"))).toMatchObject({
      version: 1,
      bindings: { [bot.id]: v1Binding },
    });
    expect(normalizeLegacyHermesBinding(v1Binding)).toEqual(localHermes);
    const resolved = resolveBotRuntimeBinding(bot);
    expect(resolved).toEqual({ state: "available", value: localHermes });
    expect(readFileSync(join(DATA_DIR, "hermes-bindings.json"))).toEqual(before);
    expect(loadHermesBindings()).toMatchObject({ state: "available" });
  });

  it("normalizes a bridge Hermes placement from the existing bridge sidecar", async () => {
    const { resolveBotRuntimeBinding } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "RemoteHermes" });
    expect(
      setHermesBridgeBinding(bot.id, {
        bridgeId: "bridge-mini",
        profile: "research",
        bindingVersion: 1,
      }),
    ).toEqual({ state: "available", value: undefined });
    expect(resolveBotRuntimeBinding(bot)).toEqual({ state: "available", value: bridgeHermes });
  });

  it("treats an unreadable Hermes sidecar as unavailable, never an empty provider binding", async () => {
    const { resolveBotRuntimeBinding } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Locked" });
    const sidecar = join(DATA_DIR, "hermes-bindings.json");
    writeFileSync(sidecar, "{not-json", { mode: 0o600 });
    expect(resolveBotRuntimeBinding(bot)).toMatchObject({
      state: "unavailable",
      code: "malformed_response",
    });
    chmodSync(sidecar, 0o000);
    expect(resolveBotRuntimeBinding(bot)).toMatchObject({
      state: "unavailable",
      code: "state_unavailable",
    });
    chmodSync(sidecar, 0o600);
  });

  it("plans an idle local Hermes rebind and preserves the bot id", async () => {
    const { planBotRuntimeRebind } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief" });
    const writeSpy = vi.spyOn(atomic, "writeFileAtomic");
    const beforeCount = writeSpy.mock.calls.length;
    const result = planBotRuntimeRebind({
      bot,
      requested: localHermes,
      contextMode: "none",
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok !== true) return;
    expect(result.plan.preservedBotId).toBe(bot.id);
    expect(result.plan.previous).toEqual(providerClaude);
    expect(result.plan.next).toEqual(localHermes);
    expect(result.plan.requiresApproval).toBe(true);
    expect(result.plan.handoffSummary).toBe("");
    expect(writeSpy.mock.calls.length).toBe(beforeCount);
    writeSpy.mockRestore();
  });

  it("rejects rebinding unless the bot is idle", async () => {
    const { planBotRuntimeRebind } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Busy" });
    store.setActivity(bot.id, "working");
    const result = planBotRuntimeRebind({
      bot: store.bot(bot.id)!,
      requested: localHermes,
      contextMode: "none",
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(result).toMatchObject({ ok: false, code: "bot_active" });
  });

  it("rejects a missing or unreadable Hermes endpoint", async () => {
    const { planBotRuntimeRebind } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief" });
    expect(
      planBotRuntimeRebind({
        bot,
        requested: localHermes,
        contextMode: "none",
        endpoint: { state: "missing" },
      }),
    ).toMatchObject({ ok: false, code: "endpoint_unavailable" });
    expect(
      planBotRuntimeRebind({
        bot,
        requested: bridgeHermes,
        contextMode: "none",
        endpoint: { state: "unreadable", endpointId: "bridge-mini:research" },
      }),
    ).toMatchObject({ ok: false, code: "endpoint_unreadable" });
  });

  it("rejects a sanitized context handoff that carries secret-shaped keys", async () => {
    const { planBotRuntimeRebind } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief" });
    const result = planBotRuntimeRebind({
      bot,
      requested: localHermes,
      contextMode: "summary",
      context: {
        summary: "Continue the weekly briefing",
        api_key: "sk-ant-secret-value-123456",
      },
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_handoff" });
    if (result.ok === false) {
      expect(JSON.stringify(result)).not.toMatch(/sk-ant-secret-value-123456/);
    }
  });

  it("builds a bounded handoff summary without secret-shaped keys or session ids", async () => {
    const { planBotRuntimeRebind } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief" });
    const result = planBotRuntimeRebind({
      bot,
      requested: localHermes,
      contextMode: "summary",
      context: {
        summary: "Continue the weekly briefing for the research fleet.",
        topics: ["hiring", "infra"],
      },
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok !== true) return;
    expect(result.plan.handoffSummary).toContain("weekly briefing");
    expect(result.plan.handoffSummary).not.toMatch(/session|token|secret|api[_-]?key/i);
  });

  it("applies a rebind without deleting identity, hierarchy, transcript, or grants", async () => {
    const { planBotRuntimeRebind, applyBotRuntimeRebind, resolveBotRuntimeBinding } = await import(
      "./bot-runtime-binding.ts"
    );
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", title: "Chief of Staff" });
    store.setChiefOfStaff(chief.id);
    const bot = store.createBot({
      name: "Specialist",
      title: "Research lead",
      description: "Owns research",
      reportsToBotId: chief.id,
      modelSelection: selection(),
    });
    store.patchBot(bot.id, {
      avatarUrl: "att://avatar-1",
      unread: true,
      pinned: true,
      pinnedMessageId: "msg-pin",
      alwaysAllow: ["Bash"],
      computer: "vm",
      permissionMode: "ask",
    });
    const threadId = bot.threadId;
    store.appendMessage(threadId, { role: "user", kind: "text", text: "keep this transcript" });
    const identityBefore = {
      id: bot.id,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      avatarUrl: store.bot(bot.id)!.avatarUrl,
      reportsToBotId: store.bot(bot.id)!.reportsToBotId,
      unread: store.bot(bot.id)!.unread,
      pinned: store.bot(bot.id)!.pinned,
      pinnedMessageId: store.bot(bot.id)!.pinnedMessageId,
      alwaysAllow: store.bot(bot.id)!.alwaysAllow,
      computer: store.bot(bot.id)!.computer,
      permissionMode: store.bot(bot.id)!.permissionMode,
      threadId,
    };
    const planned = planBotRuntimeRebind({
      bot: store.bot(bot.id)!,
      requested: localHermes,
      contextMode: "none",
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(planned).toMatchObject({ ok: true });
    if (planned.ok !== true) return;
    const applied = await applyBotRuntimeRebind(planned.plan, {
      store,
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(applied.id).toBe(identityBefore.id);
    expect(applied.name).toBe(identityBefore.name);
    expect(applied.title).toBe(identityBefore.title);
    expect(applied.description).toBe(identityBefore.description);
    expect(applied.avatarUrl).toBe(identityBefore.avatarUrl);
    expect(applied.reportsToBotId).toBe(identityBefore.reportsToBotId);
    expect(applied.unread).toBe(identityBefore.unread);
    expect(applied.pinned).toBe(identityBefore.pinned);
    expect(applied.pinnedMessageId).toBe(identityBefore.pinnedMessageId);
    expect(applied.alwaysAllow).toEqual(identityBefore.alwaysAllow);
    expect(applied.computer).toBe(identityBefore.computer);
    expect(applied.permissionMode).toBe(identityBefore.permissionMode);
    expect(applied.threadId).toBe(identityBefore.threadId);
    expect(store.messagesFor(threadId).some((message) => message.text === "keep this transcript")).toBe(true);
    expect(resolveBotRuntimeBinding(applied)).toEqual({ state: "available", value: localHermes });
    const sidecar = loadHermesBindings();
    expect(sidecar.state).toBe("available");
    if (sidecar.state === "available") {
      expect(sidecar.value.get(bot.id)).toEqual(v1Binding);
    }
  });

  it("rejects apply when the bot becomes active or the endpoint revision changes", async () => {
    const { planBotRuntimeRebind, applyBotRuntimeRebind } = await import("./bot-runtime-binding.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief" });
    const planned = planBotRuntimeRebind({
      bot,
      requested: localHermes,
      contextMode: "none",
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(planned).toMatchObject({ ok: true });
    if (planned.ok !== true) return;
    store.setActivity(bot.id, "working");
    await expect(
      applyBotRuntimeRebind(planned.plan, {
        store,
        endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
      }),
    ).rejects.toMatchObject({ code: "bot_active" });
    store.setActivity(bot.id, "idle");
    await expect(
      applyBotRuntimeRebind(planned.plan, {
        store,
        endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-2" },
      }),
    ).rejects.toMatchObject({ code: "stale_endpoint" });
  });

  it("rolls back sidecar writes when the bot record cannot be patched so identities cannot drift", async () => {
    const { planBotRuntimeRebind, applyBotRuntimeRebind, resolveBotRuntimeBinding } = await import(
      "./bot-runtime-binding.ts"
    );
    const store = new Store(selection);
    const bot = store.createBot({ name: "Specialist", modelSelection: selection() });
    const planned = planBotRuntimeRebind({
      bot: store.bot(bot.id)!,
      requested: localHermes,
      contextMode: "none",
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(planned).toMatchObject({ ok: true });
    if (planned.ok !== true) return;
    const originalPatch = store.patchBot.bind(store);
    store.patchBot = ((id, patch) => {
      if (patch.runtimeBinding) return null;
      return originalPatch(id, patch);
    }) as typeof store.patchBot;
    await expect(
      applyBotRuntimeRebind(planned.plan, {
        store,
        endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
      }),
    ).rejects.toMatchObject({ code: "bot_not_found" });
    store.patchBot = originalPatch;
    const current = store.bot(bot.id)!;
    expect(current.runtimeBinding).toBeUndefined();
    expect(resolveBotRuntimeBinding(current)).toEqual({ state: "available", value: providerClaude });
    const sidecar = loadHermesBindings();
    expect(sidecar.state).toBe("available");
    if (sidecar.state === "available") expect(sidecar.value.has(bot.id)).toBe(false);
  });

  it("reverses a Hermes binding back to the previous provider runtime", async () => {
    const { planBotRuntimeRebind, applyBotRuntimeRebind, resolveBotRuntimeBinding } = await import(
      "./bot-runtime-binding.ts"
    );
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief", modelSelection: selection() });
    const toHermes = planBotRuntimeRebind({
      bot,
      requested: localHermes,
      contextMode: "none",
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    expect(toHermes).toMatchObject({ ok: true });
    if (toHermes.ok !== true) return;
    await applyBotRuntimeRebind(toHermes.plan, {
      store,
      endpoint: { state: "available", endpointId: "local:coder", capabilityRevision: "rev-1" },
    });
    const rebound = store.bot(bot.id)!;
    const back = planBotRuntimeRebind({
      bot: rebound,
      requested: providerClaude,
      contextMode: "none",
    });
    expect(back).toMatchObject({ ok: true });
    if (back.ok !== true) return;
    const restored = await applyBotRuntimeRebind(back.plan, { store });
    expect(resolveBotRuntimeBinding(restored)).toEqual({ state: "available", value: providerClaude });
    expect(restored.modelSelection).toEqual(selection());
    const sidecar = loadHermesBindings();
    expect(sidecar.state).toBe("available");
    if (sidecar.state === "available") expect(sidecar.value.has(bot.id)).toBe(false);
  });
});
