import { describe, expect, it } from "vitest";

import type { Bot, Group } from "@/state/store";
import {
  foldVBotEngineSync,
  isVBotReconstructedActive,
  parseVBotEngineSync,
  reconstructedActionUnavailable,
  vbotMutationPath,
  vbotProviderInstances,
  type VBotEngineSync,
} from "./vbot-engine";

function sync(overrides: Partial<VBotEngineSync> = {}): VBotEngineSync {
  return {
    primaryEngine: "grokReconstructed",
    activeSource: "grokReconstructed",
    fallback: false,
    fallbackCode: null,
    fallbackReason: null,
    engines: [
      { id: "openmaus", displayName: "Vi Bot", state: "available" },
      {
        id: "grokReconstructed",
        displayName: "Grok Reconstructed",
        state: "available",
      },
    ],
    bots: [{ id: "chief", label: "Chief", busy: false }],
    groups: [],
    modelCapabilities: {
      defaultModel: "active",
      models: [{ id: "active", label: "Active" }],
      sendPrompt: true,
      images: false,
      queueing: false,
      steer: false,
      stop: true,
      attachments: false,
    },
    providers: null,
    router: null,
    ...overrides,
  };
}

const openBot = (id: string, threadId = `thread-${id}`): Bot => ({
  id,
  threadId,
  name: id,
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "codex", model: "default" },
  messages: [{ id: "old", role: "bot", kind: "text", text: "old", at: 1 }],
});

const openGroup = (id: string): Group => ({
  id,
  threadId: `room-${id}`,
  name: id,
  memberIds: ["chief"],
  defaultResponder: { kind: "everyone" },
  bulletin: "",
  unread: false,
  createdAt: 1,
  messages: [],
});

describe("V Bot engine sync", () => {
  it("keeps only public, bounded fields from an untrusted response", () => {
    const parsed = parseVBotEngineSync({
      ...sync(),
      bots: [
        { id: "chief", label: " Chief ", token: "secret", cwd: "/private" },
      ],
      providers: {
        scope: "host",
        perBotSelection: false,
        currentProvider: "cursor",
        currentModelId: "composer",
        providers: [
          {
            id: "cursor",
            label: "Cursor",
            selectable: true,
            modelSelectable: true,
            models: [
              {
                id: "composer",
                current: true,
                selectable: true,
                token: "secret",
              },
            ],
          },
        ],
        token: "secret",
      },
    });
    expect(parsed?.bots).toEqual([{ id: "chief", label: "Chief" }]);
    expect(parsed?.providers).toEqual({
      scope: "host",
      perBotSelection: false,
      currentProvider: "cursor",
      currentModelId: "composer",
      providers: [
        {
          id: "cursor",
          label: "Cursor",
          current: false,
          selectable: true,
          modelSelectable: true,
          models: [{ id: "composer", current: true, selectable: true }],
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("folds reconstructed roster into stable source-specific threads", () => {
    const previous = openBot("chief");
    const first = foldVBotEngineSync(sync(), [previous], []);
    expect(first.bots[0]).toMatchObject({
      id: "chief",
      name: "Chief",
      threadId: "vbot-grokReconstructed-chief",
    });
    expect(first.bots[0]?.messages).toEqual([]);
    const next = foldVBotEngineSync(sync(), first.bots, []);
    expect(next.bots[0]?.threadId).toBe(first.bots[0]?.threadId);
  });

  it("switches back to OpenMaus without retaining reconstructed thread ids", () => {
    const reconstructed = foldVBotEngineSync(sync(), [openBot("chief")], []);
    const open = foldVBotEngineSync(
      sync({
        primaryEngine: "openmaus",
        activeSource: "openmaus",
        bots: [{ id: "chief", label: "Chief", model: "default" }],
      }),
      reconstructed.bots,
      [],
    );
    expect(open.bots[0]?.threadId).not.toContain("grokReconstructed");
    expect(open.bots[0]?.threadId).toBe("vbot-openmaus-chief");
  });

  it("projects sanitized host providers into picker instances", () => {
    const instances = vbotProviderInstances(
      sync({
        providers: {
          scope: "host",
          perBotSelection: false,
          currentProvider: "cursor",
          currentModelId: "composer",
          providers: [
            {
              id: "cursor",
              label: "Cursor",
              current: true,
              selectable: true,
              modelSelectable: true,
              models: [{ id: "composer", current: true, selectable: true }],
            },
            {
              id: "openrouter",
              label: "OpenRouter",
              current: false,
              selectable: false,
              modelSelectable: false,
              models: [],
            },
          ],
        },
      }),
    );
    expect(instances.map((instance) => instance.instanceId)).toEqual([
      "cursor",
      "openrouter",
    ]);
    expect(instances[0]?.models.default).toBe("composer");
    expect(instances[1]?.snapshot.state).toBe("unavailable");
  });

  it("does not route mutations while the selected engine has fallen back", () => {
    const unavailable = sync({
      activeSource: "openmaus",
      fallback: true,
      fallbackReason: "Start the gateway.",
    });
    expect(isVBotReconstructedActive(unavailable)).toBe(false);
    expect(reconstructedActionUnavailable(unavailable, "send")).toBe(
      "Start the gateway.",
    );
    expect(reconstructedActionUnavailable(sync(), "steer")).toBe(
      "Steering is unavailable on Grok Reconstructed.",
    );
  });

  it("builds validated mutation paths", () => {
    expect(vbotMutationPath("chief", "turns")).toBe(
      "/api/vbot/bots/chief/turns",
    );
    expect(vbotMutationPath("chief.alpha", "stop")).toBe(
      "/api/vbot/bots/chief.alpha/stop",
    );
    expect(() => vbotMutationPath("../secret", "turns")).toThrow(
      "bot id is invalid",
    );
  });

  it("keeps group transcripts when the same source snapshot refreshes", () => {
    const room = openGroup("room");
    const first = foldVBotEngineSync(
      sync({ groups: [{ id: "room", label: "Room", memberIds: ["chief"] }] }),
      [],
      [room],
    );
    expect(first.groups[0]?.threadId).toBe("vbot-grokReconstructed-room");
    const second = foldVBotEngineSync(
      sync({ groups: [{ id: "room", label: "Room", memberIds: ["chief"] }] }),
      first.bots,
      first.groups,
    );
    expect(second.groups[0]?.threadId).toBe(first.groups[0]?.threadId);
  });
});
