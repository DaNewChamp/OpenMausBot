import { useEffect, useState } from "react";
import { api } from "@/state/store";

export type ReviewerMode = "off" | "when-unclear" | "always";

export interface ReviewerModel {
  id: string;
  label: string;
}

export interface ReviewerProvider {
  id: string;
  label: string;
  instanceId: string;
  available: boolean;
  configured: boolean;
  reason: string | null;
  models: ReviewerModel[];
}

export interface ReviewerStatus {
  mode: ReviewerMode;
  selection: { instanceId: string; model: string } | null;
  providers: ReviewerProvider[];
}

const MODES: Array<{ id: ReviewerMode; label: string }> = [
  { id: "off", label: "Off" },
  { id: "when-unclear", label: "When unclear" },
  { id: "always", label: "Always" },
];

export function ExplainToolRequestsSettings({
  status,
  saving,
  error,
  onSave,
}: {
  status: ReviewerStatus | null;
  saving: boolean;
  error?: string;
  onSave: (patch: { mode: ReviewerMode; instanceId?: string; model?: string }) => void;
}) {
  const selected = status?.selection;
  const active = status?.providers.find((provider) =>
    selected
      ? provider.instanceId === selected.instanceId && provider.models.some((model) => model.id === selected.model)
      : provider.available,
  ) ?? status?.providers.find((provider) => provider.available) ?? status?.providers[0];

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
              onSave({
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
      <p className="text-[12px] leading-relaxed text-ink-secondary">
        Explains approval requests in plain language. Local safety checks always decide whether to pause, and you still approve or deny.
      </p>
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
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

  return (
    <ExplainToolRequestsSettings
      status={status}
      saving={saving}
      error={error}
      onSave={(patch) => void save(patch)}
    />
  );
}

export const ExplainToolRequests = ApprovalReviewerSettings;
