import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Bot } from "@/state/store";
import {
  VOICE_CONFIG_PATH,
  VoiceSettingsPanel,
  incompatibleVoiceCopy,
  kokoroConfiguredCopy,
  kokoroUnconfiguredCopy,
  listedVoiceReady,
  patchVoiceConfig,
  voiceEngineOptions,
} from "./VoiceSettings";

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Raven",
    title: "Tester",
    description: "",
    notifications: false,
    color: "teal",
    unread: false,
    modelSelection: { instanceId: "inst-1", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

describe("voice engine options", () => {
  it("offers Kokoro everywhere and Mac voices only on Darwin", () => {
    const linux = voiceEngineOptions(false);
    expect(linux.map((o) => o.value)).toEqual(["elevenlabs", "kokoro"]);
    const mac = voiceEngineOptions(true);
    expect(mac.map((o) => o.value)).toEqual(["elevenlabs", "kokoro", "system"]);
    expect(mac.find((o) => o.value === "kokoro")?.label).toMatch(/self-hosted/i);
  });
});

describe("Kokoro copy", () => {
  it("does not claim the phone synthesizes, or that a flag means the server is up", () => {
    expect(kokoroConfiguredCopy()).toMatch(/operator|self-hosted|not necessarily this phone/i);
    expect(kokoroUnconfiguredCopy()).toMatch(/OMB_KOKORO_BASE_URL/i);
    expect(kokoroUnconfiguredCopy()).toMatch(/not proof/i);
    expect(kokoroConfiguredCopy() + kokoroUnconfiguredCopy()).not.toMatch(/microphone|this phone synthesizes/i);
  });
});

describe("incompatible current voice", () => {
  it("keeps the id but refuses preview until a listed voice is chosen", () => {
    expect(listedVoiceReady("21m00Tcm4TlvDq8ikWAM", "", ["af_heart", "af_bella"])).toBe(false);
    expect(listedVoiceReady("af_heart", "", ["af_heart", "af_bella"])).toBe(true);
    expect(listedVoiceReady("", "af_heart", ["af_heart"])).toBe(true);
    expect(listedVoiceReady("Albert", "", [])).toBe(false);
    expect(incompatibleVoiceCopy()).toMatch(/pick a voice/i);
    expect(incompatibleVoiceCopy()).toMatch(/kept/i);
  });
});

describe("VoiceSettingsPanel", () => {
  it("shows the unconfigured Kokoro state without a voice picker", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettingsPanel, {
        bot: bot(),
        tts: { configured: false, ready: false, voice: "", provider: "kokoro" },
        voices: [],
        loadingVoices: false,
        systemVoicesAvailable: false,
        onPatch: () => undefined,
        onProvider: () => undefined,
        onPreview: () => undefined,
        onSaveKey: () => undefined,
        onKeyChange: () => undefined,
        keyValue: "",
      }),
    );
    expect(html).toContain("Kokoro (self-hosted)");
    expect(html).toContain(kokoroUnconfiguredCopy());
    expect(html).not.toContain("aria-label=\"Raven's voice\"");
    expect(html).not.toMatch(/microphone/i);
  });

  it("keeps an ElevenLabs voice id visible and asks the user to pick a Kokoro voice", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceSettingsPanel, {
        bot: bot({ voice: "21m00Tcm4TlvDq8ikWAM" }),
        tts: { configured: true, ready: false, voice: "v-1", provider: "kokoro" },
        voices: [
          { id: "af_heart", label: "af_heart" },
          { id: "af_bella", label: "Bella" },
        ],
        loadingVoices: false,
        systemVoicesAvailable: false,
        onPatch: () => undefined,
        onProvider: () => undefined,
        onPreview: () => undefined,
        onSaveKey: () => undefined,
        onKeyChange: () => undefined,
        keyValue: "",
      }),
    );
    expect(html).toContain("21m00Tcm4TlvDq8ikWAM");
    expect(html.replaceAll("&#x27;", "'" )).toContain(incompatibleVoiceCopy());
    expect(html.replaceAll("&#x27;", "'" )).toContain(kokoroConfiguredCopy());
    expect(html).toMatch(/disabled/);
  });
});

describe("paired voice settings boundaries", () => {
  it("does not present a key writer to paired browsers", () => {
    const html = renderToStaticMarkup(createElement(VoiceSettingsPanel, {
      bot: bot(), tts: { configured: false, ready: false, voice: "", provider: "elevenlabs" },
      voices: [], loadingVoices: false, systemVoicesAvailable: false,
      credentialEditingAllowed: false,
      onPatch: () => {}, onProvider: () => {}, onPreview: () => {}, onSaveKey: () => {}, onKeyChange: () => {},
    }));
    expect(html).toContain("Credentials are managed in desktop Settings or the hub environment.");
    expect(html).not.toContain('type="password"');
  });
  it("cannot preview a stale catalog during provider switching", () => {
    const html = renderToStaticMarkup(createElement(VoiceSettingsPanel, {
      bot: bot({ voice: "af_heart" }), tts: { configured: true, ready: true, voice: "", provider: "kokoro" },
      voices: [{ id: "af_heart", label: "Heart" }], loadingVoices: true, switching: true,
      systemVoicesAvailable: false, onPatch: () => {}, onProvider: () => {}, onPreview: () => {}, onSaveKey: () => {}, onKeyChange: () => {},
    }));
    expect(html).toMatch(/<button disabled="" title="Pick a voice first" aria-label="Hear this voice"/);
  });
});

describe("patchVoiceConfig", () => {
  it("writes the narrow PATCH and never a broad /api/config", async () => {
    const seen: Array<{ path: string; init?: RequestInit }> = [];
    const request = async (path: string, init?: RequestInit) => {
      seen.push({ path, init });
      return { tts: { configured: true, ready: false, voice: "", provider: "kokoro" as const } };
    };
    await patchVoiceConfig({ provider: "kokoro" }, request);
    expect(VOICE_CONFIG_PATH).toBe("/api/config/voice");
    expect(seen).toEqual([
      {
        path: "/api/config/voice",
        init: { method: "PATCH", body: JSON.stringify({ provider: "kokoro" }) },
      },
    ]);
    expect(seen[0]?.path).not.toBe("/api/config");
  });
});
