// Per-agent voice profile. The key is shared; the voice and autoplay choice
// belong to the selected bot.
//
// The voice list comes from the harness, which holds credentials and the
// operator Kokoro URL. Workspace provider/voice metadata uses the narrow
// PATCH /api/config/voice. Keys stay on the existing host credential path;
// paired clients never gain an additional credential writer.
import { useEffect, useState } from "react";
import { Check, Loader2, Volume2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";
import { isWebClientMode } from "@/lib/web-client-mode";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

export const VOICE_CONFIG_PATH = "/api/config/voice";

export type VoiceProviderId = "elevenlabs" | "system" | "kokoro";

export type VoiceConfigRequest = (path: string, init?: RequestInit) => Promise<unknown>;

export function voiceEngineOptions(systemAvailable: boolean): Array<{
  value: VoiceProviderId;
  label: string;
  available: boolean;
}> {
  const options: Array<{ value: VoiceProviderId; label: string; available: boolean }> = [
    { value: "elevenlabs", label: "ElevenLabs", available: true },
    { value: "kokoro", label: "Kokoro (self-hosted)", available: true },
  ];
  if (systemAvailable) options.push({ value: "system", label: "Built-in Mac voices", available: true });
  return options;
}

export function kokoroConfiguredCopy(): string {
  return "Synthesis runs on the operator's Kokoro host, which may be local or self-hosted — not necessarily this phone or browser.";
}

export function kokoroUnconfiguredCopy(): string {
  return "Kokoro is not configured on this hub yet. The operator sets OMB_KOKORO_BASE_URL; selecting this provider is not proof the voice server is reachable.";
}

export function incompatibleVoiceCopy(): string {
  return "This agent's current voice is not available on the selected provider. Pick a voice below — the previous choice is kept until you do.";
}

export function listedVoiceReady(selectedVoice: string, workspaceVoice: string, listedIds: string[]): boolean {
  const id = selectedVoice || workspaceVoice;
  if (!id || listedIds.length === 0) return false;
  return listedIds.includes(id);
}

export async function patchVoiceConfig(
  fields: { provider?: VoiceProviderId; voice?: string },
  request: VoiceConfigRequest = api,
): Promise<ConfigStatus> {
  return request(VOICE_CONFIG_PATH, {
    method: "PATCH",
    body: JSON.stringify(fields),
  }) as Promise<ConfigStatus>;
}

type VoiceOption = { id: string; label: string; description?: string };

export function VoiceSettingsPanel({
  bot,
  tts,
  voices,
  loadingVoices,
  systemVoicesAvailable,
  switching = false,
  saving = false,
  error = null,
  keyValue = "",
  credentialEditingAllowed = true,
  onPatch,
  onProvider,
  onPreview,
  onSaveKey,
  onKeyChange,
}: {
  bot: Bot;
  tts: NonNullable<ConfigStatus["tts"]>;
  voices: VoiceOption[];
  loadingVoices: boolean;
  systemVoicesAvailable: boolean;
  switching?: boolean;
  saving?: boolean;
  error?: string | null;
  keyValue?: string;
  credentialEditingAllowed?: boolean;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies">>) => void;
  onProvider: (next: VoiceProviderId) => void;
  onPreview: () => void;
  onSaveKey: () => void;
  onKeyChange: (value: string) => void;
}) {
  const provider = tts.provider ?? "elevenlabs";
  const configured = Boolean(tts.configured);
  const selectedVoice = bot.voice ?? "";
  const listedIds = voices.map((voice) => voice.id);
  const previewReady = configured && !loadingVoices && !switching && listedVoiceReady(selectedVoice, tts.voice, listedIds);
  const effectiveVoice = selectedVoice || tts.voice;
  const incompatible =
    configured && !loadingVoices && Boolean(effectiveVoice) && voices.length > 0 && !listedIds.includes(effectiveVoice);
  const options = voiceEngineOptions(systemVoicesAvailable);
  if (provider === "system" && !options.some((option) => option.value === "system")) {
    options.push({ value: "system", label: "Built-in Mac voices", available: false });
  }

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Voice</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Give this agent a voice for calls and spoken replies. The voice choice belongs to this agent;
        {provider === "system"
          ? systemVoicesAvailable
            ? " the voices are the ones already installed on this Mac."
            : " built-in Mac voices are unavailable here. Switch to ElevenLabs or Kokoro to keep using voice."
          : provider === "kokoro"
            ? ` ${kokoroConfiguredCopy()}`
            : " the ElevenLabs key is shared by the workspace."}
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[13px] text-ink-secondary">Voice engine</div>
        <div className="inline-flex max-w-full flex-wrap rounded-xl bg-inset p-1" role="radiogroup" aria-label="Voice engine">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={provider === option.value}
              disabled={switching || !option.available}
              title={!option.available ? "Built-in voices are available only on macOS" : undefined}
              onClick={() => onProvider(option.value)}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-[12.5px] transition-colors disabled:opacity-50",
                provider === option.value ? "bg-raised text-ink shadow" : "text-ink-secondary hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {provider === "elevenlabs" && credentialEditingAllowed && (
        <div className="mt-4">
        <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
          <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
          <span>ElevenLabs key</span>
          {configured && <span className="text-[11px] text-success">Connected</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={keyValue}
            onChange={(e) => onKeyChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && keyValue.trim() && onSaveKey()}
            placeholder={configured ? "••••••••  (paste to replace)" : "Paste your ElevenLabs API key"}
            aria-label="ElevenLabs key"
            autoComplete="off"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <button
            onClick={() => onSaveKey()}
            disabled={saving || !keyValue.trim()}
            className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        </div>
        {!configured && (
          <a
            href="https://elevenlabs.io/app/settings/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[12px] font-medium text-accent hover:underline"
          >
            Get a key from ElevenLabs
          </a>
        )}
        </div>
      )}

      {provider === "elevenlabs" && !credentialEditingAllowed && (
        <div className="mt-4 text-[13px] leading-relaxed text-ink-secondary">
          {configured ? "An ElevenLabs key is configured on this hub." : "No ElevenLabs key is configured on this hub."}
          {" "}Credentials are managed in desktop Settings or the hub environment. This paired client can choose a voice without handling the key.
        </div>
      )}

      {provider === "kokoro" && (
        <div className="mt-4 text-[13px] text-ink-secondary">
          {configured ? (
            <div className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-success" />
              <span>Kokoro endpoint is configured on this hub. That is not live connectivity proof.</span>
            </div>
          ) : (
            kokoroUnconfiguredCopy()
          )}
        </div>
      )}

      {configured && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] text-ink-secondary">Voice</div>
          <div className="flex gap-2">
            <select
              value={selectedVoice}
              onChange={(e) => onPatch({ voice: e.target.value })}
              aria-label={`${bot.name}'s voice`}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
            >
              <option value="">
                {loadingVoices
                  ? "Loading voices…"
                  : tts.voice
                    ? "Workspace default"
                    : "Pick a voice"}
              </option>
              {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) && (
                <option value={selectedVoice}>Current agent voice</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                  {v.description ? `: ${v.description}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => onPreview()}
              disabled={!previewReady}
              title={previewReady ? "Hear this voice" : "Pick a voice first"}
              aria-label="Hear this voice"
              className="flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Volume2 size={14} /> Try
            </button>
          </div>
          {incompatible && (
            <div role="alert" className="mt-2 text-[12px] text-danger">{incompatibleVoiceCopy()}</div>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Read replies aloud</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">
            Speak this agent's answers as they arrive, even from another chat.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={Boolean(bot.speakReplies)}
          aria-label="Read this bot's replies aloud"
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
          className={cn(
            "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
            bot.speakReplies ? "bg-accent" : "bg-control",
          )}
        >
          <span
            className={cn(
              "absolute top-[3px] size-5 rounded-full bg-white transition-all",
              bot.speakReplies ? "left-[21px]" : "left-[3px]",
            )}
          />
        </button>
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies">>) => void;
}) {
  const { state, dispatch } = useStore();
  const tts = state.config?.tts;
  const credentialEditingAllowed = !isWebClientMode();

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);

  const { capabilities } = useDesktopCapabilities();
  const systemVoicesAvailable = capabilities.host.platform === "darwin";
  const provider = tts?.provider ?? "elevenlabs";
  const configured = Boolean(tts?.configured);

  useEffect(() => {
    setVoices([]);
    setError(null);
    if (!configured) {
      setLoadingVoices(false);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((r: { voices?: VoiceOption[]; error?: string }) => {
        if (!alive) return;
        setVoices(r.voices ?? []);
        if (r.error) setError(r.error);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setVoices([]);
        setError(cause instanceof Error ? cause.message : "Could not load voices from the hub.");
      })
      .finally(() => alive && setLoadingVoices(false));
    return () => {
      alive = false;
    };
  }, [configured, provider]);

  const setProvider = (next: VoiceProviderId) => {
    if (next === provider || switching || (next === "system" && !systemVoicesAvailable)) return;
    setSwitching(true);
    setError(null);
    patchVoiceConfig({ provider: next })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSwitching(false));
  };

  const saveKey = () => {
    const nextKey = key.trim();
    if (!credentialEditingAllowed || !nextKey) return Promise.resolve();
    setSaving(true);
    setError(null);
    const request = window.ogb?.setCredential
      ? window.ogb.setCredential("ttsKey", nextKey)
      : api("/api/config", { method: "PUT", body: JSON.stringify({ tts: { key: nextKey } }) });
    return request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setKey("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  if (!tts) return null;

  return (
    <VoiceSettingsPanel
      bot={bot}
      tts={tts}
      voices={voices}
      loadingVoices={loadingVoices}
      systemVoicesAvailable={systemVoicesAvailable}
      switching={switching}
      saving={saving}
      error={error}
      keyValue={key}
      credentialEditingAllowed={credentialEditingAllowed}
      onPatch={onPatch}
      onProvider={setProvider}
      onPreview={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
      onSaveKey={() => void saveKey()}
      onKeyChange={setKey}
    />
  );
}
