import { Hand, Loader2, Settings } from "lucide-react";

/** Browsing a shared preview is not a grant to drive it for an unassigned bot. */
export function ComputerControlButton({ canControl, pending, onTake, onConfigure }: {
  canControl: boolean;
  pending: boolean;
  onTake: () => void;
  onConfigure: () => void;
}) {
  return (
    <button
      type="button"
      onClick={canControl ? onTake : onConfigure}
      disabled={pending}
      className="shell-pane-btn mt-3 w-full bg-control text-ink hover:bg-raised-hover disabled:opacity-50"
      title={canControl ? "Pause the bot's hands and drive this browser yourself" : "Assign Local VM to this bot in Settings to take control"}
    >
      {pending ? <Loader2 size={14} className="animate-spin" /> : canControl ? <Hand size={14} /> : <Settings size={14} />}
      {canControl ? "Take control" : "View only · Computer settings"}
    </button>
  );
}
