import { loadHermesBindings } from "./engines/bindings.ts";
import { HermesEngineError } from "./engines/contracts.ts";

export type HermesBindingLoader = typeof loadHermesBindings;

/** Stable membership/send error while Hermes groups remain unsupported. */
export function hermesGroupsUnavailable(): HermesEngineError {
  return new HermesEngineError("groups_unavailable");
}

/** Reject group create/PATCH membership when a member is Hermes-bound or
 * binding state cannot be proven unbound. */
export function hermesGroupMembershipError(
  memberIds: readonly string[],
  loadBindings: HermesBindingLoader = loadHermesBindings,
): HermesEngineError | null {
  const bindings = loadBindings();
  if (bindings.state === "unavailable") return new HermesEngineError(bindings.code);
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
