// Pending approval, ported from the upstream pattern: an approval does
// not sit in the transcript waiting to be noticed — it takes over the
// composer. The prompt is disabled, a strip above it says exactly what
// is being asked, and the send row is replaced by the decisions.
//
// Faithful details worth keeping: one at a time with an "n of N" counter,
// the detail printed raw in a monospace block that is NEVER truncated
// (it scrolls instead), and the buttons ordered least-destructive-last so
// the primary action sits under your thumb.
import { memo } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { toolApprovalPresentation } from "@/lib/tool-approval-presentation";



export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  /** the narrow grant "always allow" writes, computed server-side */
  allowKey?: string;
  detail: string;
  held?: string;
  reason?: string;
  alwaysAllowSummary?: string;
  executiveSummary?: string;
  changeSummary?: string;
  resourceSummary?: string;
  riskLevel?: "low" | "medium" | "high";
  advisorySummary?: string;
}

/** Open approvals on a thread, oldest first — answered/dismissed drop out. */
export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      detail: m.card!.details ?? m.card!.subtitle,
      held: m.card!.held,
      reason: m.card!.reason,
      alwaysAllowSummary: m.card!.allowKey ? m.card!.alwaysAllowSummary : undefined,
      executiveSummary: m.card!.executiveSummary,
      changeSummary: m.card!.changeSummary,
      resourceSummary: m.card!.resourceSummary,
      riskLevel: m.card!.riskLevel,
      advisorySummary: m.card!.advisorySummary,
    }));
}



export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
  bot,
}: {
  pending: Pending;
  count: number;
  index: number;
  bot?: Bot;
}) {
  const card = pending.message?.card ?? {
    tool: pending.tool,
    details: pending.detail,
    reason: pending.reason,
    allowKey: pending.allowKey,
    alwaysAllowSummary: pending.alwaysAllowSummary,
    executiveSummary: pending.executiveSummary,
    changeSummary: pending.changeSummary,
    resourceSummary: pending.resourceSummary,
    riskLevel: pending.riskLevel,
  };
  const presentation = toolApprovalPresentation(bot?.name ?? "", card);

  return (
    <div className="rounded-t-2xl border-b border-hairline/50 bg-control/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-[0.18em] text-ink-secondary">Pending approval</span>
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {index + 1} of {count}
          </span>
        )}
      </div>
      <div className="mt-1 text-[13.5px] font-semibold text-ink">
        {presentation.headline}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
            presentation.isReadOnly
              ? "border border-success/20 bg-success/10 text-success"
              : "border border-warning/20 bg-warning/10 text-warning",
          )}
        >
          {presentation.changeDescription}
        </span>
      </div>
      <div className="mt-3 rounded-xl border border-hairline/40 bg-card/70 px-3 py-2.5">
        <div className="text-[12px] font-medium text-ink-secondary">Reason</div>
        <div className="mt-1 text-[13px] leading-relaxed text-ink">
          {pending.reason || "This request needs your approval before the bot can continue. Nothing runs unless you approve."}
        </div>
        {pending.allowKey && pending.alwaysAllowSummary && (
          <div className="mt-2 border-t border-hairline/30 pt-2">
            <div className="text-[13px] font-medium text-accent">Always allow</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{pending.alwaysAllowSummary}</div>
          </div>
        )}
      </div>
      {pending.executiveSummary && (
        <div className="mt-2 text-[13px] leading-relaxed text-ink">
          <span className="font-medium text-ink-secondary">What this does · </span>{pending.executiveSummary}
        </div>
      )}
      {pending.advisorySummary && (
        <div className="mt-2 rounded-lg border border-hairline/40 bg-control/40 px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
          <span className="font-medium text-ink">AI review · advisory: </span>{pending.advisorySummary}
        </div>
      )}
      <details className="mt-2 rounded-lg border border-hairline/30 bg-inset/70 px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">Details</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">
          {presentation.detailsText}
        </pre>
      </details>
      {pending.held && <div className="mt-2 text-[12px] text-warning">{pending.held}</div>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
}: {
  pending: Pending;
  threadId: string;
  /** who asked — "always allow" is remembered against them */
  bot?: Bot;
}) {
  const { dispatch } = useStore();
  const decide = (behavior: "allow" | "deny", always = false) =>
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : undefined,
      alwaysAllow: always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined,
    });

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  return (
    <div className="flex flex-col items-stretch gap-1 px-2 py-2">
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => decide("deny")}
          className={cn(base, "border border-danger/40 text-danger hover:bg-danger/10")}
        >
          Deny
        </button>
        <button
          onClick={() => decide("allow")}
          className={cn(base, "bg-accent font-medium text-white hover:brightness-110")}
        >
          Allow
        </button>
      </div>
      {bot && pending.allowKey && pending.alwaysAllowSummary && (
        <button
          onClick={() => decide("allow", true)}
          title={`Stop asking ${bot.name} about this narrow action`}
          className={cn(base, "self-end text-ink-secondary hover:bg-control hover:text-ink")}
        >
          Always allow
        </button>
      )}
    </div>
  );
}
