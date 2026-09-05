// Voice, wired to config. Three engines live behind this file: ElevenLabs
// (elevenlabs.ts, needs a key), the Mac's built-in voices (system-voices.ts,
// no key), and optional hub-side Kokoro (kokoro.ts, operator URL).
import type { AppConfig } from "../config.ts";
import * as elevenlabs from "./elevenlabs.ts";
import * as kokoro from "./kokoro.ts";
import { kokoroBridgeSettings } from "./bridge-kokoro.ts";
import * as systemVoices from "./system-voices.ts";

export type VoiceProvider = "elevenlabs" | "system" | "kokoro";
type KokoroOptions = Parameters<typeof kokoro.listKokoroVoices>[0];

export function kokoroConfigured(): boolean {
  // An explicit bridge selection never silently falls back to another host.
  if (process.env.OMB_KOKORO_BRIDGE_ID !== undefined) return Boolean(kokoroBridgeSettings());
  return Boolean(kokoro.kokoroEndpoint());
}

export class NoVoiceConfigured extends Error {
  // a plain field rather than a constructor parameter property: the harness
  // runs under `node --experimental-strip-types`, which is strip-ONLY, so a
  // parameter property is rejected at load time even though it typechecks
  readonly reason: "key" | "voice";

  constructor(reason: "key" | "voice", detail?: string) {
    super(
      detail ??
        (reason === "key"
          ? "Add an ElevenLabs key in Settings on the computer to turn on voice."
          : "Pick a voice in the agent profile."),
    );
    this.reason = reason;
  }
}

export function voiceProvider(cfg: AppConfig): VoiceProvider {
  const provider = cfg.tts?.provider;
  if (provider === "system" || provider === "kokoro") return provider;
  return "elevenlabs";
}

/** The system provider needs no credential — it is only ever offered where
 * the platform actually has it, so "configured" means "this engine can
 * speak", not "a key is on file". Kokoro is configured when the operator
 * URL is present and valid, which is not live connectivity proof. */
export function providerConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") return systemVoices.systemVoicesAvailable();
  if (provider === "kokoro") return kokoroConfigured();
  return Boolean(cfg.tts?.key);
}

export function voiceConfigured(cfg: AppConfig): boolean {
  const provider = voiceProvider(cfg);
  if (provider === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(cfg.tts?.voice);
  }
  if (provider === "kokoro") {
    return Boolean(kokoroConfigured() && kokoro.isKokoroVoiceId(cfg.tts?.voice));
  }
  return Boolean(cfg.tts?.key && cfg.tts?.voice);
}

/** A per-bot voice is a complete choice too; it should not be blocked just
 * because the app-wide fallback has not been selected yet. */
export function voiceReady(cfg: AppConfig, voiceId?: string): boolean {
  const provider = voiceProvider(cfg);
  const chosen = voiceId || cfg.tts?.voice;
  if (provider === "system") {
    return systemVoices.systemVoicesAvailable() && Boolean(chosen);
  }
  if (provider === "kokoro") {
    return Boolean(kokoroConfigured() && kokoro.isKokoroVoiceId(chosen));
  }
  return Boolean(cfg.tts?.key && chosen);
}

/** What the settings panel needs. Never includes the key — same write-only
 * rule as every other credential. */
export function describeVoice(cfg: AppConfig) {
  return {
    configured: providerConfigured(cfg),
    ready: voiceConfigured(cfg),
    voice: cfg.tts?.voice ?? "",
    provider: voiceProvider(cfg),
  };
}

export function verifyKey(key: string) {
  return elevenlabs.verifyKey(key);
}

export async function listVoices(cfg: AppConfig, run?: systemVoices.Runner, kokoroOptions?: KokoroOptions): Promise<elevenlabs.Voice[]> {
  const provider = voiceProvider(cfg);
  if (provider === "system") return systemVoices.listSystemVoices(run);
  if (provider === "kokoro") {
    if (!kokoroConfigured()) return [];
    return kokoro.listKokoroVoices(kokoroOptions);
  }
  const key = cfg.tts?.key;
  if (!key) return [];
  return elevenlabs.listVoices(key);
}

/** Synthesize one utterance. Throws NoVoiceConfigured when there is nothing
 * to speak with, which the route turns into a 409 the client can explain. */
export function speak(cfg: AppConfig, text: string, voiceId?: string, run?: systemVoices.Runner, kokoroOptions?: KokoroOptions) {
  const provider = voiceProvider(cfg);
  if (provider === "system") {
    const voice = voiceId || cfg.tts?.voice;
    // An injected runner is the cross-platform test seam for `/usr/bin/say`;
    // production calls omit it and remain strictly Darwin-gated.
    if (!systemVoices.systemVoicesAvailable() && !run) throw new NoVoiceConfigured("key");
    if (!voice) throw new NoVoiceConfigured("voice");
    return systemVoices.synthesizeSystem(text, voice, run);
  }
  if (provider === "kokoro") {
    if (!kokoroConfigured()) {
      throw new NoVoiceConfigured(
        "key",
        "Configure the Kokoro endpoint or speech bridge on the hub to turn on voice.",
      );
    }
    const voice = voiceId || cfg.tts?.voice;
    if (!voice) throw new NoVoiceConfigured("voice");
    if (!kokoro.isKokoroVoiceId(voice)) {
      throw new NoVoiceConfigured("voice", new kokoro.IncompatibleKokoroVoice().message);
    }
    return kokoro.synthesizeKokoro(text, voice, kokoroOptions).catch((error: unknown) => {
      if (error instanceof kokoro.IncompatibleKokoroVoice) {
        throw new NoVoiceConfigured("voice", error.message);
      }
      throw error;
    });
  }
  const key = cfg.tts?.key;
  if (!key) throw new NoVoiceConfigured("key");
  const voice = voiceId || cfg.tts?.voice;
  if (!voice) throw new NoVoiceConfigured("voice");
  return elevenlabs.synthesize(text, voice, key);
}

export function systemProviderAvailable(platform?: string): boolean {
  return systemVoices.systemVoicesAvailable(platform);
}

export { applyVoiceConfigPatch } from "./voice-config.ts";
export { kokoroEndpoint } from "./kokoro.ts";
export type { Voice } from "./elevenlabs.ts";
