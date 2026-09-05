import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { GLOBAL_STYLE_INSTRUCTIONS_LABEL } from "@/lib/global-style";

export function GlobalStyleSettingsView({
  enabled,
  instructions,
  saving,
  error,
  onToggle,
  onChangeInstructions,
  onBlurInstructions,
}: {
  enabled: boolean;
  instructions: string;
  saving: boolean;
  error?: string;
  onToggle: () => void;
  onChangeInstructions: (text: string) => void;
  onBlurInstructions: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Applies to every bot</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            New turns pick it up right away; existing conversations don't change retroactively.
          </div>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Apply global style to every bot"
          disabled={saving}
          onClick={onToggle}
          className={`${cnSwitch(enabled)} disabled:cursor-wait disabled:opacity-50`}
        >
          <span className={cnKnob(enabled)} />
        </button>
      </div>
      <textarea
        aria-label={GLOBAL_STYLE_INSTRUCTIONS_LABEL}
        value={instructions}
        disabled={!enabled || saving}
        rows={5}
        onChange={(event) => onChangeInstructions(event.target.value)}
        onBlur={onBlurInstructions}
        placeholder="e.g. Keep answers concise, avoid unnecessary caveats."
        className="w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
      />
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        A bot's own instructions win over this. Individual bots can opt out in their profile.
      </p>
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function GlobalStyleSettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.houseStyle;
  const [enabled, setEnabled] = useState(confirmed?.enabled ?? true);
  const [text, setText] = useState(confirmed?.instructions ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dirty) return;
    setEnabled(confirmed?.enabled ?? true);
    setText(confirmed?.instructions ?? "");
  }, [confirmed?.enabled, confirmed?.instructions, dirty]);

  const save = async (patch: { enabled: boolean; instructions: string }) => {
    if (saving) return;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ houseStyle: patch }),
      });
      dispatch({ type: "configStatus", config });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save global style.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    setDirty(false);
    void save({ enabled: next, instructions: text });
  };

  return (
    <GlobalStyleSettingsView
      enabled={enabled}
      instructions={text}
      saving={saving}
      error={error}
      onToggle={toggle}
      onChangeInstructions={(value) => {
        setText(value);
        setDirty(true);
      }}
      onBlurInstructions={() => {
        if (!dirty) return;
        setDirty(false);
        void save({ enabled, instructions: text });
      }}
    />
  );
}

// Keep backwards-compatible alias for any legacy imports
export const HouseStyleSettings = GlobalStyleSettings;

const cnSwitch = (on: boolean) =>
  `relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-control"}`;
const cnKnob = (on: boolean) =>
  `absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${on ? "left-[21px]" : "left-[3px]"}`;
