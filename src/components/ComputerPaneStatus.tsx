import type { Action } from "@/state/store";
import { cn } from "@/lib/cn";
import type { ComputerStatusSummary } from "@/lib/computer-status";
import type { FleetHost } from "@/lib/fleet-hosts";

type ToggleAppSettingsAction = Extract<Action, { type: "toggleAppSettings" }>;

export const COMPUTER_PANE_SETUP_LABEL = "Set up in Settings";
export const COMPUTER_PANE_MANAGE_LABEL = "Manage in Settings";

export function localVmSettingsAction(): ToggleAppSettingsAction {
  return { type: "toggleAppSettings", open: true, section: "computer" };
}

export function computerPaneLooksReady(input: {
  statusReady: boolean;
  hostOnline?: boolean | null;
}): boolean {
  if (input.hostOnline === false) return false;
  return input.statusReady === true;
}

export type ComputerPaneHostState = "online" | "offline" | "unselected";
export type ComputerPaneIsolationKind = "shared" | "own" | "unknown";

export interface ComputerPaneContext {
  hostName: string;
  hostState: ComputerPaneHostState;
  isolationKind: ComputerPaneIsolationKind;
  isolationLabel: string;
  isolationDetail: string;
  compactLine: string;
}

export function computerPaneContext(input: {
  host?: Pick<FleetHost, "name" | "online"> | null;
  isolation?: "shared" | "per-bot" | null;
}): ComputerPaneContext {
  const hostName = input.host?.name.trim() ?? "";
  const hostState: ComputerPaneHostState = !input.host
    ? "unselected"
    : input.host.online
      ? "online"
      : "offline";
  const isolationKind: ComputerPaneIsolationKind =
    input.isolation === "per-bot" ? "own" : input.isolation === "shared" ? "shared" : "unknown";
  const isolationLabel =
    isolationKind === "own" ? "Own browser" : isolationKind === "shared" ? "Shared browser" : "Browser";
  const isolationDetail =
    isolationKind === "own"
      ? "A Chromium container for this bot on the selected machine."
      : isolationKind === "shared"
        ? "One Chromium container shared by every bot on the selected machine. Bots take turns."
        : "A Chromium container on the selected fleet machine.";
  const compactLine = hostName
    ? `${hostName} · ${hostState} · ${isolationLabel}`
    : "No machine selected";
  return { hostName, hostState, isolationKind, isolationLabel, isolationDetail, compactLine };
}

export interface ComputerPaneLifecycleNav {
  kind: "setup" | "manage";
  label: typeof COMPUTER_PANE_SETUP_LABEL | typeof COMPUTER_PANE_MANAGE_LABEL;
  action: ToggleAppSettingsAction;
}

export function computerPaneLifecycleNav(input: {
  container?: "running" | "stopped" | "missing" | null;
  ready?: boolean;
}): ComputerPaneLifecycleNav {
  const exists = input.ready === true || input.container === "running" || input.container === "stopped";
  return exists
    ? { kind: "manage", label: COMPUTER_PANE_MANAGE_LABEL, action: localVmSettingsAction() }
    : { kind: "setup", label: COMPUTER_PANE_SETUP_LABEL, action: localVmSettingsAction() };
}

export function ComputerPaneStatus({
  context,
  summary,
  lifecycle,
  onOpenSettings,
}: {
  context: ComputerPaneContext;
  summary: ComputerStatusSummary;
  lifecycle: ComputerPaneLifecycleNav;
  onOpenSettings: () => void;
}) {
  return (
    <div
      data-computer-pane-status
      data-host-state={context.hostState}
      data-isolation={context.isolationKind}
      data-tone={summary.tone}
      data-lifecycle={lifecycle.kind}
      className="mb-2"
    >
      <p className="min-w-0 text-[12px] leading-snug text-ink-secondary">{context.compactLine}</p>
      <p
        className={cn(
          "mt-1 text-[12.5px] font-medium",
          summary.tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {summary.title}
      </p>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{summary.detail}</p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="shell-pane-btn mt-2 bg-control text-ink hover:bg-raised-hover"
      >
        {lifecycle.label}
      </button>
    </div>
  );
}
