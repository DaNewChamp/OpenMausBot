import { useEffect, useState } from "react";

import { api } from "@/state/store";

type ReviewerMode = "off" | "when-unclear" | "always";

interface ReviewerModel {
  id: string;
  label: string;
}

interface ReviewerProvider {
  id: string;
  label: string;
  instanceId: string;
  available: boolean;
  configured: boolean;
  reason: string | null;
  models: ReviewerModel[];
}

interface ReviewerStatus {
  mode: ReviewerMode;
  selection: { instanceId: string; model: string } | null;
  providers: ReviewerProvider[];
}

const MODES: Array<{ id: ReviewerMode; label: string }> = [
  { id: "off", label: "Off" },
  { id: "when-unclear", label: "When unclear" },
  { id: "always", label: "Always" },
];

function providerKey(provider: ReviewerProvider): string {
  return `${provider.instanceId}:${provider.id}`;
}

export function ApprovalReviewerSettings() {
  const [status, setStatus] = useState<ReviewerStatus | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    api("/api/approval-reviewer")
      .then((next: ReviewerStatus) => {
        setStatus(next);
        setError("");
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (patch: { mode: ReviewerMode; instanceId?: string; model?: string }) => {
    if (saving) return;
    setSaving(true);
    try {
      const next: ReviewerStatus = await api("/api/approval-reviewer", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      setStatus(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const selected = status?.selection;
  const active = status?.providers.find((provider) =>
    selected
      ? provider.instanceId === selected.instanceId && provider.models.some((model) => model.id === selected.model)
      : provider.available,
  ) ?? status?.providers.find((provider) => provider.available) ?? status?.providers[0];
  const models = active?.models ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1 rounded-lg bg-inset p-1">
        {MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            disabled={saving || !status}
            aria-pressed={status?.mode === mode.id}
            onClick={() => {
              if (!status) return;
              void save({
                mode: mode.id,
                ...(selected?.instanceId && selected.model
                  ? selected
                  : active?.models[0]
                    ? { instanceId: active.instanceId, model: active.models[0].id }
                    : {}),
              });
            }}
            className={`rounded-md px-2.5 py-1.5 text-[13px] ${
              status?.mode === mode.id ? "bg-card text-ink" : "text-ink-secondary hover:text-ink"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {status && (
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium text-ink" htmlFor="approval-reviewer-provider">
            Model
          </label>
          <select
            id="approval-reviewer-provider"
            disabled={saving}
            value={active ? providerKey(active) : ""}
            onChange={(event) => {
              const next = status.providers.find((provider) => providerKey(provider) === event.target.value);
              if (!next) return;
              const model = next.models.find((entry) => entry.id === selected?.model)?.id ?? next.models[0]?.id;
              if (!model) return;
              void save({ mode: status.mode, instanceId: next.instanceId, model });
            }}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
          >
            {status.providers.map((provider) => (
              <option key={providerKey(provider)} value={providerKey(provider)} disabled={!provider.available}>
                {provider.available ? provider.label : `${provider.label}: ${provider.reason}`}
              </option>
            ))}
          </select>
          {models.length > 1 && (
            <select
              aria-label="Approval reviewer model"
              disabled={saving || !active?.available}
              value={selected?.model ?? active?.models[0]?.id ?? ""}
              onChange={(event) => {
                if (!active) return;
                void save({ mode: status.mode, instanceId: active.instanceId, model: event.target.value });
              }}
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          {active && !active.available && active.reason && (
            <p className="text-[12px] leading-relaxed text-ink-secondary">{active.reason}</p>
          )}
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        Optional summaries only. This never approves or denies an action, and it cannot lower the local risk.
      </p>
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
