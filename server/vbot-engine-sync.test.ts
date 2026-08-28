import { describe, expect, it } from "vitest";

import {
  leaksSensitive,
  projectReconstructedRoster,
  publicDisabledReason,
  type ReconstructedProbe,
} from "./drivers/grok-reconstructed.ts";
import {
  buildVBotEngineSync,
  mutateReconstructedVbotTurn,
  parseVBotPrimaryEnginePatch,
  requireReconstructedMutation,
  requireReconstructedRead,
  vbotPrimaryEngine,
} from "./vbot-engine-sync.ts";

const openmaus = {
  bots: [
    {
      id: "bot_1",
      name: "Scout",
      title: "Scout",
      busy: false,
      activity: "idle",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    },
  ],
  groups: [{ id: "room_1", name: "Ops", memberIds: ["bot_1"], busyBotId: null }],
};

const reconstructedAvailable = {
  ok: true,
  discovery: { port: 18765, pid: 42, startedAt: 1, scheme: "http" as const, host: "127.0.0.1", token: "secret" },
  origin: "http://127.0.0.1:18765",
  token: "secret",
  sessions: [{ id: "bot-alpha", label: "Alpha", isActive: true, isRunning: false }],
  roster: projectReconstructedRoster([
    {
      id: "bot-alpha",
      name: "Alpha",
      path: "/Users/someone/.grokbot/agents/bot-alpha/store.db",
      isActive: true,
      isRunning: false,
    },
    {
      id: "group-ops",
      name: "Ops",
      isGroup: true,
      memberIds: ["bot-alpha"],
    },
  ]),
  capabilities: {
    health: true,
    listAgents: true,
    sendPrompt: false,
    events: false,
    transcriptTail: false,
    vbotInterop: false,
    steer: false,
    stop: false,
    selectHostRouter: false,
  },
} satisfies Extract<ReconstructedProbe, { ok: true }>;

const reconstructedUnavailable = {
  ok: false,
  code: "installed-not-running",
} as const satisfies ReconstructedProbe;

describe("vbot primary engine config", () => {
  it("defaults to openmaus and accepts only the two engine ids", () => {
    expect(vbotPrimaryEngine({})).toBe("openmaus");
    expect(vbotPrimaryEngine({ vbot: { primaryEngine: "grokReconstructed" } })).toBe("grokReconstructed");
    expect(parseVBotPrimaryEnginePatch({ primaryEngine: "openmaus" })).toBe("openmaus");
    expect(parseVBotPrimaryEnginePatch({ primaryEngine: "grokReconstructed" })).toBe("grokReconstructed");
    expect(parseVBotPrimaryEnginePatch({ primaryEngine: "official" })).toBeNull();
    expect(parseVBotPrimaryEnginePatch({ primaryEngine: "openmaus", extra: true })).toBeNull();
  });
});

describe("reconstructed roster projection", () => {
  it("splits bots and groups without leaking host paths", () => {
    const roster = projectReconstructedRoster([
      {
        id: "bot-alpha",
        name: "Alpha",
        path: "/Users/someone/.grokbot/agents/bot-alpha/store.db",
        avatarDataUrl: "data:image/png;base64,secret",
        isActive: true,
      },
      { id: "group-ops", name: "Ops", isGroup: true, memberIds: ["bot-alpha", "bad id"] },
      { id: "active", name: "Reserved" },
    ]);
    expect(roster).toEqual({
      bots: [{ id: "bot-alpha", label: "Alpha", isActive: true }],
      groups: [{ id: "group-ops", label: "Ops", memberIds: ["bot-alpha"] }],
    });
    expect(JSON.stringify(roster)).not.toContain(".grokbot");
    expect(JSON.stringify(roster)).not.toContain("avatarDataUrl");
  });
});

describe("vbot engine sync projection", () => {
  it("projects openmaus bots when that engine is primary", () => {
    const sync = buildVBotEngineSync({
      primaryEngine: "openmaus",
      reconstructed: reconstructedUnavailable,
      openmaus,
    });
    expect(sync).toMatchObject({
      primaryEngine: "openmaus",
      activeSource: "openmaus",
      fallback: false,
      fallbackCode: null,
      bots: [{ id: "bot_1", label: "Scout", model: "claude-sonnet-5" }],
      groups: [{ id: "room_1", label: "Ops", memberIds: ["bot_1"] }],
      modelCapabilities: {
        sendPrompt: true,
        images: true,
        queueing: true,
        steer: true,
        stop: true,
      },
    });
    expect(sync.engines.map((engine) => engine.id)).toEqual(["openmaus", "grokReconstructed"]);
    expect(sync.engines[1]).toMatchObject({
      state: "unavailable",
      code: "installed-not-running",
      reason: publicDisabledReason("installed-not-running"),
    });
  });

  it("projects reconstructed bots when that engine is available", () => {
    const sync = buildVBotEngineSync({
      primaryEngine: "grokReconstructed",
      reconstructed: reconstructedAvailable,
      openmaus,
    });
    expect(sync).toMatchObject({
      primaryEngine: "grokReconstructed",
      activeSource: "grokReconstructed",
      fallback: false,
      bots: [{ id: "bot-alpha", label: "Alpha", isActive: true }],
      groups: [{ id: "group-ops", label: "Ops", memberIds: ["bot-alpha"] }],
      modelCapabilities: {
        defaultModel: "bot-alpha",
        models: [
          { id: "active", label: "Active reconstructed bot" },
          { id: "bot-alpha", label: "Alpha" },
        ],
        sendPrompt: false,
        images: false,
        queueing: false,
        steer: false,
        stop: false,
      },
    });
    const wire = JSON.stringify(sync);
    expect(leaksSensitive(wire, ["secret", "18765"])).toBe(false);
    expect(wire).not.toContain("127.0.0.1");
    expect(wire).not.toContain("gateway.json");
  });

  it("falls back to openmaus with a typed code when reconstructed is unavailable", () => {
    const sync = buildVBotEngineSync({
      primaryEngine: "grokReconstructed",
      reconstructed: reconstructedUnavailable,
      openmaus,
    });
    expect(sync).toMatchObject({
      primaryEngine: "grokReconstructed",
      activeSource: "openmaus",
      fallback: true,
      fallbackCode: "installed-not-running",
      fallbackReason: publicDisabledReason("installed-not-running"),
      bots: [{ id: "bot_1", label: "Scout" }],
    });
  });
});

describe("reconstructed mutation guard", () => {
  it("lets reads fail closed when reconstructed is down instead of mixing engines", () => {
    expect(() => requireReconstructedRead(reconstructedUnavailable)).toThrow(/installed but not running/);
    expect(() => requireReconstructedRead(reconstructedAvailable)).toThrow(/interoperability API is not available/);
  });

  it("never falls back a mutating send to OpenMaus", async () => {
    expect(() => requireReconstructedMutation("openmaus", reconstructedAvailable)).toThrow(
      /not the selected desktop engine/,
    );
    try {
      requireReconstructedMutation("grokReconstructed", reconstructedUnavailable);
      throw new Error("expected mutation guard to throw");
    } catch (error) {
      expect(error).toMatchObject({
        name: "ReconstructedVbotError",
        code: "engine-mutation-blocked",
        status: 409,
      });
    }
    await expect(
      mutateReconstructedVbotTurn(
        "grokReconstructed",
        reconstructedUnavailable,
        "bot-alpha",
        { prompt: "hello" },
        false,
      ),
    ).rejects.toMatchObject({ code: "engine-mutation-blocked", status: 409 });
  });

  it("projects reconstructed steer and stop flags from interop capabilities", () => {
    const sync = buildVBotEngineSync({
      primaryEngine: "grokReconstructed",
      reconstructed: {
        ...reconstructedAvailable,
        capabilities: {
          ...reconstructedAvailable.capabilities,
          vbotInterop: true,
          sendPrompt: true,
          steer: true,
          stop: true,
          selectHostRouter: true,
        },
      },
      openmaus,
    });
    expect(sync.modelCapabilities).toMatchObject({
      sendPrompt: true,
      steer: true,
      stop: true,
      queueing: false,
    });
  });
});
