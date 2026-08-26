/**
 * The delivery contract shared by bot and room message endpoints.
 *
 * `auto` is deliberately the default: callers that predate the explicit
 * controls keep each endpoint's old behavior (steer-then-queue for bots and
 * serialized turns for rooms). Explicit modes are never silently rewritten
 * to another action.
 */

export type DeliveryMode = "auto" | "steer" | "queue";
export type DeliveryAction = "start" | "steer" | "queue" | "unsupported";
export type DeliveryDisposition = "started" | "steered" | "queued";

export interface MessageDeliveryReceipt {
  ok: true;
  disposition: DeliveryDisposition;
  queueId?: string;
  threadId?: string;
}

export interface DeliveryDecisionInput {
  mode: DeliveryMode;
  busy: boolean;
  canSteer: boolean;
}

/** Parse the optional message-delivery field at the HTTP boundary. */
export function parseDeliveryMode(value: unknown): DeliveryMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "steer" || value === "queue") return value;
  throw Object.assign(new Error("delivery must be auto, steer, or queue"), { status: 400 });
}

/**
 * Read the wire field while tolerating the names used by early companion
 * builds. New clients send `delivery`; the aliases cost no state and make a
 * staggered desktop/phone rollout safe.
 */
export function parseDeliveryModeFromBody(body: Record<string, unknown>): DeliveryMode {
  const fields = ["delivery", "deliveryMode", "mode"].filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (fields.length > 1) {
    const first = body[fields[0]!];
    if (fields.some((field) => body[field] !== first)) {
      throw Object.assign(new Error("delivery fields must agree"), { status: 400 });
    }
  }
  return parseDeliveryMode(fields.length ? body[fields[0]!] : undefined);
}

/**
 * Decide what a message can do without performing any I/O. Keeping this
 * policy pure makes the important guarantee testable: an explicit steer can
 * never fall through to the queue when the active engine cannot honour it,
 * and an explicit queue can never call the adapter's steer method.
 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryAction;
export function decideDelivery(mode: DeliveryMode, busy: boolean, canSteer: boolean): DeliveryAction;
export function decideDelivery(
  inputOrMode: DeliveryDecisionInput | DeliveryMode,
  busyArg?: boolean,
  canSteerArg?: boolean,
): DeliveryAction {
  const input: DeliveryDecisionInput = typeof inputOrMode === "string"
    ? { mode: inputOrMode, busy: Boolean(busyArg), canSteer: Boolean(canSteerArg) }
    : inputOrMode;
  if (!input.busy) return "start";
  if (input.mode === "queue") return "queue";
  if (input.mode === "steer") return input.canSteer ? "steer" : "unsupported";
  return input.canSteer ? "steer" : "queue";
}

export function deliveryReceipt(
  disposition: DeliveryDisposition,
  ids: { queueId?: string; threadId?: string } = {},
): MessageDeliveryReceipt {
  const queuedIds = disposition === "queued"
    ? {
        ...(ids.queueId ? { queueId: ids.queueId } : {}),
        ...(ids.threadId ? { threadId: ids.threadId } : {}),
      }
    : {};
  return {
    ok: true,
    disposition,
    ...queuedIds,
  };
}
