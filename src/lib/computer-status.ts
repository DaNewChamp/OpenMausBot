export type ComputerPanelPhase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

export type ComputerStatusTone = "neutral" | "positive" | "warning" | "danger";

export interface ComputerStatusSummary {
  title: string;
  detail: string;
  tone: ComputerStatusTone;
}

/** Short, honest status copy for the desktop rail. This is deliberately
 * separate from action labels: a ready preview is not the same thing as an
 * interactive viewer, and an unavailable VM should never look like a retry
 * spinner. */
export function computerStatusSummary(input: {
  phase: ComputerPanelPhase;
  cloudBackend?: "box" | "vps";
  linux?: boolean;
  reconstructed?: boolean;
  error?: string | null;
}): ComputerStatusSummary {
  if (input.reconstructed) {
    return {
      title: "Computer unavailable",
      detail: "This engine provides chat and history only; computer control stays off.",
      tone: "warning",
    };
  }
  switch (input.phase) {
    case "checking":
      return { title: "Checking computer", detail: "Verifying the desktop and its readiness.", tone: "neutral" };
    case "starting":
      return {
        title: input.cloudBackend === "vps" ? "Starting VPS computer" : "Starting cloud computer",
        detail: "Preparing a managed workspace. This can take a moment.",
        tone: "neutral",
      };
    case "ready":
      return {
        title: input.cloudBackend === "vps" ? "VPS computer ready" : "Cloud computer ready",
        detail: "The latest frame will appear here; open it to interact.",
        tone: "positive",
      };
    case "vm":
      return {
        title: "Local VM ready",
        detail: "A private per-bot workspace is running on this computer.",
        tone: "positive",
      };
    case "local":
      return {
        title: "This computer ready",
        detail: input.linux
          ? "Approved bot actions are ready; start a preview when you want to watch."
          : "The bot can use this computer while V Bot is open.",
        tone: "positive",
      };
    case "off":
      return { title: "Computer off", detail: "Turn on a computer mode in this bot's settings when needed.", tone: "neutral" };
    case "unconfigured":
      return { title: "Cloud computer not configured", detail: "Choose a cloud backend in Connections to enable it.", tone: "warning" };
    case "vps-unconfigured":
      return { title: "VPS computer not configured", detail: "Add the VPS connection before starting a managed desktop.", tone: "warning" };
    case "vps-stopped":
      return { title: "VPS computer stopped", detail: "Start it here when you want to resume cloud work.", tone: "warning" };
    case "vps-incompatible":
      return { title: "VPS computer needs replacement", detail: "This workspace belongs to an older V Bot image.", tone: "warning" };
    case "vm-unavailable":
      return { title: "Local VM unavailable", detail: "Create or repair this bot's private workspace in Local VM settings.", tone: "warning" };
    case "local-unavailable":
      return { title: "This computer unavailable", detail: "Enable the required desktop permissions, then try again.", tone: "warning" };
    case "error":
      return { title: "Computer needs attention", detail: input.error || "V Bot could not reach this computer.", tone: "danger" };
  }
}
