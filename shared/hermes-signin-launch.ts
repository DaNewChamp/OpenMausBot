import { spawn } from "node:child_process";

export const HERMES_SIGNIN_ARGV = ["setup"] as const;

export type HermesSignInKind = "browser" | "terminal";

export interface HermesSignInLaunch {
  kind: HermesSignInKind;
  argv: readonly string[];
}

export type HermesSignInLaunchResult =
  | { ok: true; kind: HermesSignInKind }
  | { ok: false };

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

export function hermesSignInArgvIsSetup(argv: unknown): argv is ["setup"] {
  return Array.isArray(argv) && argv.length === 1 && argv[0] === "setup";
}
