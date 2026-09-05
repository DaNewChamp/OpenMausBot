import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { computerActivityRows, type ComputerActivityRow } from "@/lib/computer-activity";
import { usePageVisible } from "@/lib/page-visible";

function relativeTime(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const dotTone: Record<ComputerActivityRow["tone"], string> = {
  neutral: "bg-ink-secondary/55",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function ComputerActivityTimeline({
  threadId,
  busy,
  held,
  helpReason,
}: {
  threadId: string;
  busy: boolean;
  held: boolean;
  helpReason: string | null;
}) {
  const [rows, setRows] = useState<ComputerActivityRow[]>([]);
  const pageVisible = usePageVisible();

  useEffect(() => {
    if (!pageVisible) return;
    let alive = true;
    const refresh = async () => {
      try {
        const page = await api(`/api/threads/${encodeURIComponent(threadId)}/events?limit=80`);
        if (alive) setRows(computerActivityRows(page, 7));
      } catch {
        // The activity strip is observational. A transient inspector read
        // failure must never interfere with computer control.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), busy ? 2500 : 12_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, busy, pageVisible]);

  const controlLabel = held
    ? "You have the wheel"
    : helpReason
      ? "Waiting for your help"
      : null;

  return (
    <section className="mt-2 rounded-xl border border-line/70 bg-card/55 px-3 py-2.5" aria-label="Computer activity">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
          <Activity size={13} className="text-ink-secondary" />
          Activity
        </div>
        {busy && <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-accent">Live</span>}
      </div>

      <div className="mt-2 space-y-1.5">
        {controlLabel && (
          <div className="flex items-center gap-2 text-[11.5px] text-ink-secondary">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", held ? "bg-accent" : "bg-warning")} />
            <span className="min-w-0 flex-1 truncate">{controlLabel}</span>
            <span className="text-[10px] text-ink-secondary/65">now</span>
          </div>
        )}
        {rows.length === 0 && !controlLabel ? (
          <div className="text-[11.5px] text-ink-secondary/65">No recent computer activity</div>
        ) : (
          [...rows].reverse().map((row) => (
            <div key={row.id} className="flex items-center gap-2 text-[11.5px] text-ink-secondary">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotTone[row.tone])} />
              <span className="min-w-0 flex-1 truncate">{row.label}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-ink-secondary/65">{relativeTime(row.at)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
