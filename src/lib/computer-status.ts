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
function offlineBrowserSummary(hostName?: string | null): ComputerStatusSummary {
  const name = hostName?.trim();
  return {
    title: name ? `${name} is offline` : "Selected machine is offline",
    detail: "The browser container is unavailable while that machine is offline.",
    tone: "warning",
  };
}

export function computerStatusSummary(input: {
  phase: ComputerPanelPhase;
  cloudBackend?: "box" | "vps";
  linux?: boolean;
  reconstructed?: boolean;
  error?: string | null;
  shared?: boolean;
  hostName?: string | null;
  hostOnline?: boolean | null;
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
      if (input.hostOnline === false) return offlineBrowserSummary(input.hostName);
      return {
        title: input.shared === false ? "Own browser ready" : "Shared browser ready",
        detail: input.shared === false
          ? input.hostName
            ? `A Chromium container for this bot is running on ${input.hostName}. Take control to drive it.`
            : "A Chromium container for this bot is running on the selected machine. Take control to drive it."
          : input.hostName
            ? `Every bot shares one Chromium container on ${input.hostName}. Take control to drive it; bots take turns.`
            : "Every bot shares one Chromium container on the selected machine. Take control to drive it; bots take turns.",
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
      if (input.hostOnline === false) return offlineBrowserSummary(input.hostName);
      return {
        title: "Browser not ready",
        detail: "Set up the Local VM in Settings to create the Chromium container on the selected machine.",
        tone: "warning",
      };
    case "local-unavailable":
      return { title: "This computer unavailable", detail: "Enable the required desktop permissions, then try again.", tone: "warning" };
    case "error":
      return { title: "Computer needs attention", detail: input.error || "V Bot could not reach this computer.", tone: "danger" };
  }
}
