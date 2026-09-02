import { spawn } from "node:child_process";

import { HermesEngineError } from "./engines/contracts.ts";
import {
  hermesEndpointComputerName,
  type HermesEndpointPlacement,
} from "./engines/hermes-endpoints.ts";

export type HermesSignInKind = "browser" | "terminal";

export interface HermesSignInLaunch {
  kind: HermesSignInKind;
  argv: readonly string[];
}

export interface HermesSignInHandoff {
  kind: HermesSignInKind;
  computerName: string;
  message: string;
}

export type HermesSignInLaunchResult =
  | { ok: true; kind: HermesSignInKind }
  | { ok: false };

export interface StartHermesSignInOptions {
  placement: HermesEndpointPlacement;
  localComputerName?: string;
  launch?: (command: HermesSignInLaunch) => Promise<HermesSignInLaunchResult>;
}

const SIGNIN_ARGV = ["setup"] as const;

function spawnDetached(command: string, args: readonly string[]): boolean {
  try {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Launch Hermes setup on this computer without reading stdout or stderr.
 * Argv is only `setup`. Provider tokens never pass through this process. */
export async function defaultHermesSignInLaunch(
  command: HermesSignInLaunch,
): Promise<HermesSignInLaunchResult> {
  if (process.platform === "darwin") {
    const script = "hermes setup";
    if (spawnDetached("osascript", [
      "-e",
      `tell application "Terminal" to do script ${JSON.stringify(script)}`,
    ])) {
      return { ok: true, kind: command.kind };
    }
  }
  if (spawnDetached("hermes", [...command.argv])) {
    return { ok: true, kind: command.kind };
  }
  return { ok: false };
}

export function projectHermesSignInHandoff(
  value: HermesSignInHandoff & { stdout?: string },
): HermesSignInHandoff {
  return {
    kind: value.kind,
    computerName: value.computerName,
    message: value.message,
  };
}

export async function startHermesSignIn(
  options: StartHermesSignInOptions,
): Promise<HermesSignInHandoff> {
  const computerName = hermesEndpointComputerName(
    options.placement,
    options.localComputerName,
  );
  const launch = options.launch ?? defaultHermesSignInLaunch;
  const result = await launch({ kind: "terminal", argv: SIGNIN_ARGV });
  if (!result.ok) throw new HermesEngineError("gateway_unavailable");
  return projectHermesSignInHandoff({
    kind: result.kind,
    computerName,
    message: `Complete sign-in on ${computerName}, then try again.`,
  });
}
