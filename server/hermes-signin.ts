import { spawn } from "node:child_process";

import { HermesEngineError } from "./engines/contracts.ts";
import {
  hermesEndpointComputerName,
  type HermesEndpointPlacement,
} from "./engines/hermes-endpoints.ts";
import {
  normalizeHermesSetupPlacement,
  type HermesSetupPlacement,
} from "./hermes-bridge-integration.ts";

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

function spawnDetached(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      const onError = () => resolve(false);
      const onSpawn = () => {
        child.removeListener("error", onError);
        child.unref();
        resolve(true);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    } catch {
      resolve(false);
    }
  });
}

/** Launch Hermes setup on this computer without reading stdout or stderr.
 * Argv is only `setup`. Provider tokens never pass through this process. */
export async function defaultHermesSignInLaunch(
  command: HermesSignInLaunch,
): Promise<HermesSignInLaunchResult> {
  if (process.platform === "darwin") {
    const script = "hermes setup";
    if (await spawnDetached("osascript", [
      "-e",
      `tell application "Terminal" to do script ${JSON.stringify(script)}`,
    ])) {
      return { ok: true, kind: command.kind };
    }
  }
  if (await spawnDetached("hermes", [...command.argv])) {
    return { ok: true, kind: command.kind };
  }
  return { ok: false };
}

export function parseHermesSignInInput(body: unknown):
  | { ok: true; placement: HermesSetupPlacement }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Hermes sign-in requires a JSON object" };
  }
  const values = body as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "placement")) {
    return { ok: false, error: "Hermes sign-in accepts only placement" };
  }
  const placement = normalizeHermesSetupPlacement(values.placement);
  return placement
    ? { ok: true, placement }
    : { ok: false, error: "placement must name a Hermes profile and, for bridge placements, a bridge" };
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
