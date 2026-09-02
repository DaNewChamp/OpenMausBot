export type HermesEndpointKind = "local" | "bridge";

export interface HermesEndpointPlacement {
  kind: HermesEndpointKind;
  profile: string;
  bridge?: string;
}

export type HermesEndpointAuthStatus =
  | "connected"
  | "signInRequired"
  | "offline"
  | "unavailable";

export type HermesEndpointAuthReason =
  | "missing_cli"
  | "invalid_credentials"
  | "gateway_unavailable"
  | "state_unavailable"
  | "malformed_response"
  | "timeout"
  | "profile_unavailable"
  | "upstream_error";

export interface HermesEndpointIdentity {
  id: string;
  kind: HermesEndpointKind;
  profile: string;
  computerName: string;
  label: string;
}

export interface HermesEndpointAuthInput {
  computerOnline: boolean;
  hermesReachable: boolean;
  providerConfigured: boolean;
  reason?: HermesEndpointAuthReason;
}

const DEFAULT_PROFILE_LABELS = new Set(["default", "hermes"]);

function displayComputerName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

export function hermesEndpointId(placement: HermesEndpointPlacement): string {
  const bridge = placement.kind === "bridge" && placement.bridge
    ? placement.bridge.trim().toLowerCase()
    : "hub";
  return `${placement.kind}:${bridge}:${placement.profile}`;
}

export function hermesEndpointComputerName(
  placement: HermesEndpointPlacement,
  localComputerName?: string,
): string {
  if (placement.kind === "bridge") {
    return displayComputerName(placement.bridge, "Remote computer");
  }
  return displayComputerName(localComputerName, "This computer");
}

export function hermesEndpointLabel(computerName: string, profile: string): string {
  const profileLabel = DEFAULT_PROFILE_LABELS.has(profile.toLowerCase()) ? "Hermes" : profile;
  return `${computerName} · ${profileLabel}`;
}

export function projectHermesEndpoint(
  placement: HermesEndpointPlacement,
  localComputerName?: string,
): HermesEndpointIdentity {
  const computerName = hermesEndpointComputerName(placement, localComputerName);
  return {
    id: hermesEndpointId(placement),
    kind: placement.kind,
    profile: placement.profile,
    computerName,
    label: hermesEndpointLabel(computerName, placement.profile),
  };
}

export function projectHermesEndpointAuthStatus(
  input: HermesEndpointAuthInput,
): HermesEndpointAuthStatus {
  if (!input.computerOnline) return "offline";
  if (input.reason === "invalid_credentials") return "signInRequired";
  if (input.hermesReachable && input.providerConfigured === false) return "signInRequired";
  if (!input.hermesReachable) return "unavailable";
  if (
    input.reason === "missing_cli"
    || input.reason === "gateway_unavailable"
    || input.reason === "state_unavailable"
    || input.reason === "malformed_response"
    || input.reason === "timeout"
    || input.reason === "profile_unavailable"
  ) {
    return "unavailable";
  }
  return "connected";
}
