import { loadHermesBindings } from "./engines/bindings.ts";
import { HermesEngineError } from "./engines/contracts.ts";
import { isTemporaryHermesAgentMember } from "./hermes-agent-projection.ts";
import type { HermesCapabilityManifest } from "./hermes-capabilities.ts";

export type HermesBindingLoader = typeof loadHermesBindings;

/** Stable membership/send error while Hermes groups remain unsupported. */
export function hermesGroupsUnavailable(): HermesEngineError {
  return new HermesEngineError("groups_unavailable");
}

function rejectTemporaryOrUnprovenMembers(
  memberIds: readonly string[],
  loadBindings: HermesBindingLoader,
  manifest?: HermesCapabilityManifest,
): HermesEngineError | null {
  if (memberIds.some((id) => isTemporaryHermesAgentMember(id))) return hermesGroupsUnavailable();
  if (manifest && manifest.groups === "unavailable" && memberIds.length > 0) {
    const bindings = loadBindings();
    if (bindings.state === "unavailable") return new HermesEngineError(bindings.code);
    if (memberIds.some((id) => bindings.value.has(id))) return hermesGroupsUnavailable();
  }
  const bindings = loadBindings();
  if (bindings.state === "unavailable") return new HermesEngineError(bindings.code);
  if (memberIds.some((id) => bindings.value.has(id))) return hermesGroupsUnavailable();
  return null;
}

/** Reject group create/PATCH membership when a member is Hermes-bound or
 * binding state cannot be proven unbound. Temporary MoA activities never join rooms. */
export function hermesGroupMembershipError(
  memberIds: readonly string[],
  loadBindings: HermesBindingLoader = loadHermesBindings,
  manifest?: HermesCapabilityManifest,
): HermesEngineError | null {
  return rejectTemporaryOrUnprovenMembers(memberIds, loadBindings, manifest);
}

/** Allow a 1:1 DM channel between Hermes-bound bots; keep multi-member rooms blocked. */
export function hermesPairChannelError(
  memberIds: readonly string[],
  dm: boolean,
  loadBindings: HermesBindingLoader = loadHermesBindings,
): HermesEngineError | null {
  if (memberIds.some((id) => isTemporaryHermesAgentMember(id))) return hermesGroupsUnavailable();
  const bindings = loadBindings();
  if (bindings.state === "unavailable") return new HermesEngineError(bindings.code);
  if (dm && memberIds.length === 2) return null;
  if (memberIds.some((id) => bindings.value.has(id))) return hermesGroupsUnavailable();
  return null;
}

/** Reject a room/group send, resume, or connector continuation before it can
 * reach a generic ProviderAdapter. Bound bots stay on the groups=false
 * boundary; an unreadable sidecar is unknown state, not unbound. */
export function hermesGroupDispatchError(
  botId: string,
  loadBindings: HermesBindingLoader = loadHermesBindings,
): HermesEngineError | null {
  const bindings = loadBindings();
  if (bindings.state === "unavailable") return new HermesEngineError(bindings.code);
  if (bindings.value.has(botId)) return hermesGroupsUnavailable();
  return null;
}

export function hermesSetupJson(error: HermesEngineError): {
  error: string;
  code: HermesEngineError["code"];
  setup: true;
} {
  return { error: error.message, code: error.code, setup: true };
}
