// The intentionally small Local VM contract exposed to paired phones.
//
// `containerComputerStatus` is a desktop/admin response. It contains host
// paths, image references, viewer ports and setup commands that are useful on
// the Mac and unsafe (or meaningless) in a pocket. Keep the projection
// allowlisted here so a new field in that response cannot silently cross the
// companion boundary.
import type { ContainerComputerStatus } from "./container-computer.ts";

export type LocalVmPhoneMode = "shared" | "per-bot";
export type LocalVmPhoneContainer = "running" | "stopped" | "missing";
export type LocalVmPhoneState = "ready" | "running" | "stopped" | "missing" | "unavailable";

export interface LocalVmPhoneStatus {
  mode: LocalVmPhoneMode;
  max_instances: number;
  state: LocalVmPhoneState;
  container: LocalVmPhoneContainer;
  daemon_up: boolean;
  image_ready: boolean;
  desktop_ready: boolean;
  ready: boolean;
  create_supported: boolean;
  busy: boolean;
  can_create: boolean;
  can_stop: boolean;
  can_recreate: boolean;
  problem: string | null;
}

export interface LocalVmPhoneProjectionOptions {
  mode: LocalVmPhoneMode;
  maxInstances: number;
  busy?: boolean;
}

/**
 * Convert the full host status into a phone-safe, action-oriented snapshot.
 * Dynamic desktop errors are deliberately collapsed: Cua/daemon output may
 * contain paths, commands or other host details even when the ordinary
 * status problem is safe to display.
 */
export function projectLocalVmStatus(
  status: ContainerComputerStatus,
  options: LocalVmPhoneProjectionOptions,
): LocalVmPhoneStatus {
  const busy = options.busy === true;
  const imageReady = status.image && status.imageMatches;
  const state: LocalVmPhoneState = !status.runtime || !status.daemonUp
    ? "unavailable"
    : status.container === "running"
      ? status.ready ? "ready" : "running"
      : status.container;

  const sharedMode = options.mode === "shared";
  const recreateLabel = sharedMode ? "Recreate the Local VM." : "Recreate this bot's Local VM.";
  const createLabel = sharedMode ? "Create the Local VM." : "Create this bot's Local VM.";

  const problem = status.desktop_error
    ? "The Local VM desktop is unavailable."
    : !status.runtime
      ? "Install a supported container runtime on the computer."
      : !status.daemonUp
        ? "Start the container runtime on the computer."
        : !status.image
          ? "Prepare the Local VM image on the computer."
          : status.container === "missing"
            ? createLabel
            : !status.imageMatches || !status.managed || status.network !== "loopback" || status.security !== "hardened" || status.persistence !== "durable"
              ? recreateLabel
              : status.container === "stopped"
                ? recreateLabel
                : !status.desktopReady
                  ? "The Local VM desktop is still starting."
                  : null;

  const lifecycleActions = options.mode === "per-bot" || sharedMode;
  const canCreate = lifecycleActions && status.container === "missing" && imageReady && status.create_supported && !busy;
  const canStop = lifecycleActions && status.container === "running" && !busy;
  const canRecreate = lifecycleActions && status.container !== "missing" && imageReady && !busy;

  return {
    mode: options.mode,
    max_instances: options.maxInstances,
    state,
    container: status.container,
    daemon_up: status.daemonUp,
    image_ready: imageReady,
    desktop_ready: status.desktopReady,
    ready: status.ready,
    create_supported: status.create_supported,
    busy,
    can_create: canCreate,
    can_stop: canStop,
    can_recreate: canRecreate,
    problem,
  };
}
