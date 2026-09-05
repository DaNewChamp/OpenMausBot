import type { AppConfig } from "../config.ts";

type VoiceProvider = "elevenlabs" | "system" | "kokoro";
const ALLOWED = new Set(["provider", "voice"]);
const PROVIDERS = new Set<VoiceProvider>(["elevenlabs", "system", "kokoro"]);

export interface VoiceConfigContext {
  systemVoicesAvailable: boolean;
  kokoroConfigured: boolean;
}
export type VoiceConfigPatch = { provider?: VoiceProvider; voice?: string };
export type VoiceConfigValidation =
  | { ok: true; patch: VoiceConfigPatch }
  | { ok: false; error: string };

/** Paired metadata only. Credentials remain on the existing host credential
 * path rather than introducing a second, plaintext paired-client writer. */
export function validateVoiceConfigPatch(body: unknown, ctx: VoiceConfigContext): VoiceConfigValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "voice settings require a JSON object" };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (!keys.length) return { ok: false, error: "nothing to save" };
  if (keys.some((key) => !ALLOWED.has(key))) {
    return { ok: false, error: "voice settings accept only provider and voice; credentials are managed on the host" };
  }
  const patch: VoiceConfigPatch = {};
  if (keys.includes("provider")) {
    if (typeof values.provider !== "string" || !PROVIDERS.has(values.provider as VoiceProvider)) {
      return { ok: false, error: "provider must be elevenlabs, kokoro, or system" };
    }
    if (values.provider === "system" && !ctx.systemVoicesAvailable) {
      return { ok: false, error: "Built-in Mac voices are available only on macOS." };
    }
    if (values.provider === "kokoro" && !ctx.kokoroConfigured) {
      return { ok: false, error: "Kokoro is not configured on this hub. Set OMB_KOKORO_BASE_URL." };
    }
    patch.provider = values.provider as VoiceProvider;
  }
  if (keys.includes("voice")) {
    if (typeof values.voice !== "string" || !values.voice.trim() || values.voice.length > 200 || /[\x00-\x1f\x7f]/.test(values.voice)) {
      return { ok: false, error: "voice must be a non-empty string of at most 200 characters without control characters" };
    }
    patch.voice = values.voice.trim();
  }
  return { ok: true, patch };
}

export async function applyVoiceConfigPatch(body: unknown, deps: VoiceConfigContext & {
  save: (patch: Pick<AppConfig, "tts">) => void;
}): Promise<{ ok: true; patch: Pick<AppConfig, "tts"> } | { ok: false; error: string }> {
  const validated = validateVoiceConfigPatch(body, deps);
  if (!validated.ok) return validated;
  const patch = { tts: validated.patch };
  deps.save(patch);
  return { ok: true, patch };
}
