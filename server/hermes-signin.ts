import type { BridgeRegistry } from "./bridge-registry.ts";
import { startHermesSignInOnBridge } from "./bridge-hermes.ts";
import { HermesEngineError } from "./engines/contracts.ts";
import {
  hermesEndpointComputerName,
  type HermesEndpointPlacement,
} from "./engines/hermes-endpoints.ts";
import {
  normalizeHermesSetupPlacement,
  type HermesSetupPlacement,
} from "./hermes-bridge-integration.ts";
import {
  defaultHermesSignInLaunch,
  HERMES_SIGNIN_ARGV,
  type HermesSignInKind,
  type HermesSignInLaunch,
  type HermesSignInLaunchResult,
} from "../shared/hermes-signin-launch.ts";

export {
  defaultHermesSignInLaunch,
  HERMES_SIGNIN_ARGV,
  type HermesSignInKind,
  type HermesSignInLaunch,
  type HermesSignInLaunchResult,
};

export interface HermesSignInHandoff {
  kind: HermesSignInKind;
  computerName: string;
  message: string;
}

export interface StartHermesSignInOptions {
  placement: HermesEndpointPlacement;
  localComputerName?: string;
  bridgeRegistry?: BridgeRegistry;
  launch?: (command: HermesSignInLaunch) => Promise<HermesSignInLaunchResult>;
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
  if (options.placement.kind === "bridge") {
    if (!options.bridgeRegistry) throw new HermesEngineError("gateway_unavailable");
    try {
      const started = await startHermesSignInOnBridge(options.bridgeRegistry, {
        name: options.placement.bridge,
      });
      return projectHermesSignInHandoff({
        kind: started.kind,
        computerName: started.bridgeName,
        message: `Complete sign-in on ${started.bridgeName}, then try again.`,
      });
    } catch {
      throw new HermesEngineError("gateway_unavailable");
    }
  }
  const computerName = hermesEndpointComputerName(
    options.placement,
    options.localComputerName,
  );
  const launch = options.launch ?? defaultHermesSignInLaunch;
  const result = await launch({ kind: "terminal", argv: HERMES_SIGNIN_ARGV });
  if (!result.ok) throw new HermesEngineError("gateway_unavailable");
  return projectHermesSignInHandoff({
    kind: result.kind,
    computerName,
    message: `Complete sign-in on ${computerName}, then try again.`,
  });
}
