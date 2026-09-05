// The approval box: what the bot wants to do, and the available answers.
//
// Deliberately not the lettered A/B/C list the onboarding card uses — an
// approval is a decision about one concrete action, so it shows the tool
// and the actual command/path in monospace, and the choices carry their
// own behavior instead of being matched by their label text.
import { Check, ShieldCheck, X } from "lucide-react";
import { type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { toolApprovalPresentation } from "@/lib/tool-approval-presentation";



export function ApprovalCard({
  bot,
  message,
}: {
  /** who is asking, for the "Name wants to …" line */
  bot?: Bot;
  message: Message;
}) {
  const card = message.card;
  if (!card) return null;
  const settled = card.answered;
  const presentation = toolApprovalPresentation(bot?.name ?? "", card);

  return (
    <div
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        settled ? "border-hairline/30 opacity-70" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink">
          {presentation.headline}
        </div>
      </div>

      <div
        className={cn(
          "mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium",
          presentation.isReadOnly
            ? "border border-success/20 bg-success/10 text-success"
            : "border border-warning/20 bg-warning/10 text-warning",
        )}
      >
        {presentation.changeDescription}
      </div>

      <div className="mt-3 rounded-xl border border-hairline/40 bg-inset/70 px-3 py-2.5">
        <div className="text-[12px] font-medium text-ink-secondary">Reason</div>
        <div className="mt-1 text-[13px] leading-relaxed text-ink">
          {card.reason || "This request needs your approval before the bot can continue. Nothing runs unless you approve."}
        </div>
        {card.allowKey && card.alwaysAllowSummary && !settled && (
          <div className="mt-2 border-t border-hairline/30 pt-2">
            <div className="text-[13px] font-medium text-accent">Always allow</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{card.alwaysAllowSummary}</div>
          </div>
        )}
      </div>
      {card.executiveSummary && (
        <div className="mt-2 text-[13px] leading-relaxed text-ink">
          <span className="font-medium text-ink-secondary">What this does · </span>{card.executiveSummary}
        </div>
      )}
      <details className="mt-2 rounded-lg border border-hairline/30 bg-inset px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary">Details</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-ink">
          {presentation.detailsText}
        </pre>
      </details>

      {card.held && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {card.held}
        </div>
      )}

      {/* The decision lives in the composer (one place to answer, and it
          can't be scrolled past); here we only record what happened. */}
      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {settled === "allow" ? (
          <>
            <Check size={14} className="text-success" /> Allowed
          </>
        ) : settled ? (
          <>
            <X size={14} /> Denied
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" /> Waiting for your answer below
          </>
        )}
      </div>
    </div>
  );
}
