// What a paired device is allowed to ask for.
//
// The default is deny, and that direction is the whole point: the sidecar
// sits in front of an API it does not own and cannot see the future of. A
// route that appears in the harness later is closed to phones until someone
// decides otherwise, because the alternative is that every upstream release
// silently widens what a lost phone can reach.
//
// This file used to claim that and not do it — it listed refusals and let
// everything else under `/api/` through. In the time between writing it and
// noticing, upstream added webhook triggers, connected-app authorisation and
// routines, all of which a paired phone could drive: minting an
// internet-reachable trigger, rotating a signing secret out from under
// whatever was sending to it, disconnecting a Google account. None of that
// was a decision anyone made. It was the default.
//
// So the list below is the surface, derived from what the app actually
// calls. Adding a feature to the phone means adding its route here, on
// purpose, in a diff someone can read. That cost is the feature.

/** A refusal to send back, or null to let the request through. */
export interface Denial {
  status: number;
  error: string;
}

/** One request, reduced to what the allowlist decides on. */
export interface RouteRequest {
  path: string;
  method: string;
  /** Whether the bearer token on the request matched a paired device. */
  authenticated: boolean;
}

/** Read-only Hermes setup state and the one authenticated profile import
 * action. The aliases keep clients from having to distinguish a resource
 * route from an action route while remaining exact and default-deny. */
export const HERMES_SETUP_STATUS_ROUTE = {
  method: "GET",
  path: /^\/api\/hermes\/setup(?:\/status)?$/,
} as const;

export const HERMES_SETUP_CONNECT_ROUTE = {
  method: "POST",
  path: /^\/api\/hermes\/(?:setup(?:\/connect)?|connect)$/,
} as const;

export const HERMES_SETUP_SIGNIN_ROUTE = {
  method: "POST",
  path: /^\/api\/hermes\/setup\/signin$/,
} as const;

const HERMES_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const HERMES_BOT_ID_PATTERN = /^[\w-]{1,200}$/;
const HERMES_SETUP_BODY_KEYS = new Set(["profile", "placement", "botId"]);

function isSafeHermesProfile(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (value.trim() !== value || !HERMES_PROFILE_PATTERN.test(value)) return false;
  if (/^session(?:[-_]|$)/i.test(value) || /^(?:root|resolved)[-_]?session/i.test(value)) return false;
  if (/^[0-9a-f]{16,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(value)) return false;
  return true;
}

function isSafeHermesBotId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (value.trim() !== value || !HERMES_BOT_ID_PATTERN.test(value)) return false;
  if (/^sk-/i.test(value) || /token|secret|bearer/i.test(value)) return false;
  return true;
}

function safeBridgeName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f]/.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

export interface HermesSetupPlacementBody {
  kind: "local" | "bridge";
  profile: string;
  bridge?: string;
}

function normalizeHermesSetupPlacement(value: unknown): HermesSetupPlacementBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.bridgeId !== undefined || record.bridge_id !== undefined) return undefined;
  const kind = record.kind;
  if (kind !== "local" && kind !== "bridge") return undefined;
  if (!isSafeHermesProfile(record.profile)) return undefined;
  const profile = record.profile.toLowerCase();
  if (kind === "local") return { kind, profile };
  const bridge = safeBridgeName(record.bridge);
  if (!bridge) return undefined;
  return { kind, profile, bridge };
}

export function isHermesSetupStatus(method: string, path: string): boolean {
  return method === HERMES_SETUP_STATUS_ROUTE.method && HERMES_SETUP_STATUS_ROUTE.path.test(path);
}

export function isHermesSetupConnect(method: string, path: string): boolean {
  return method === HERMES_SETUP_CONNECT_ROUTE.method && HERMES_SETUP_CONNECT_ROUTE.path.test(path);
}

export function isHermesSetupSignIn(method: string, path: string): boolean {
  return method === HERMES_SETUP_SIGNIN_ROUTE.method && HERMES_SETUP_SIGNIN_ROUTE.path.test(path);
}

export function validateHermesSetupBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { profile?: string; placement?: HermesSetupPlacementBody; botId?: string } {
  if (isHermesSetupSignIn(method, path)) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { denial: { status: 400, error: "Hermes sign-in requires a JSON object" } };
    }
    const values = body as Record<string, unknown>;
    if (Object.keys(values).some((key) => key !== "placement")) {
      return { denial: { status: 400, error: "Hermes sign-in accepts only placement" } };
    }
    const placement = normalizeHermesSetupPlacement(values.placement);
    return placement
      ? { placement }
      : { denial: { status: 400, error: "placement must name a Hermes profile and, for bridge placements, a bridge" } };
  }
  if (!isHermesSetupConnect(method, path)) return {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "Hermes setup requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const extra = Object.keys(values).find((key) => !HERMES_SETUP_BODY_KEYS.has(key));
  if (extra) return { denial: { status: 400, error: `unsupported Hermes setup field: ${extra}` } };
  if (values.profile !== undefined && values.placement !== undefined) {
    return { denial: { status: 400, error: "Hermes setup accepts only profile or placement" } };
  }
  let botId: string | undefined;
  if (values.botId !== undefined) {
    if (!isSafeHermesBotId(values.botId)) {
      return { denial: { status: 400, error: "botId must name an existing bot" } };
    }
    botId = values.botId;
  }
  if (values.placement !== undefined) {
    const placement = normalizeHermesSetupPlacement(values.placement);
    return placement
      ? { placement, ...(botId ? { botId } : {}) }
      : { denial: { status: 400, error: "placement must name a Hermes profile and, for bridge placements, a bridge" } };
  }
  if (values.profile === undefined) return botId ? { botId } : {};
  if (!isSafeHermesProfile(values.profile)) {
    return { denial: { status: 400, error: "profile must be a Hermes profile name" } };
  }
  return { profile: values.profile.toLowerCase(), ...(botId ? { botId } : {}) };
}

/** The one companion route that crosses into full interactive desktop
 * control. Both the allowlist and capability gate consume this classifier so
 * their security decisions cannot drift apart. */
export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

/** The phone-safe Local VM status projection. The shared desktop lifecycle
 * route is deliberately not included: a phone may inspect only the VM
 * attached to the bot it is viewing. */
export const LOCAL_VM_STATUS_ROUTE = {
  method: "GET",
  path: /^\/api\/bots\/[\w-]+\/local-computer$/,
} as const;

/** The only Local VM mutations a paired phone may request. `run` is the
 * create operation; `recreate` is one guarded server-side replacement. */
export const LOCAL_VM_ACTION_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/(?:run|stop|recreate)$/,
} as const;

export function isLocalVmStatus(method: string, path: string): boolean {
  return method === LOCAL_VM_STATUS_ROUTE.method && LOCAL_VM_STATUS_ROUTE.path.test(path);
}

export function isLocalVmAction(method: string, path: string): boolean {
  return method === LOCAL_VM_ACTION_ROUTE.method && LOCAL_VM_ACTION_ROUTE.path.test(path);
}

/** Read-only Local VM desktop capture. Same per-device Local VM gate as
 * status. Empty body; no exec, no input. */
export const LOCAL_VM_SCREENSHOT_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/screenshot$/,
} as const;

/** Mint a proxied noVNC viewer path for this bot's ready Local VM. */
export const LOCAL_VM_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/join$/,
} as const;

/** Send bounded click/scroll/type/key input to a ready Local VM desktop. */
export const LOCAL_VM_INPUT_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/input$/,
} as const;

/** Read-only noVNC assets for the proxied Local VM viewer. */
export const LOCAL_VM_VIEWER_ROUTE = {
  method: "GET",
  path: /^\/api\/bots\/[\w-]+\/local-computer\/viewer(\/|$)/,
} as const;

export function isLocalVmScreenshot(method: string, path: string): boolean {
  return method === LOCAL_VM_SCREENSHOT_ROUTE.method && LOCAL_VM_SCREENSHOT_ROUTE.path.test(path);
}

export function isLocalVmJoin(method: string, path: string): boolean {
  return method === LOCAL_VM_JOIN_ROUTE.method && LOCAL_VM_JOIN_ROUTE.path.test(path);
}

export function isLocalVmInput(method: string, path: string): boolean {
  return method === LOCAL_VM_INPUT_ROUTE.method && LOCAL_VM_INPUT_ROUTE.path.test(path);
}

export function isLocalVmViewer(method: string, path: string): boolean {
  return method === LOCAL_VM_VIEWER_ROUTE.method && LOCAL_VM_VIEWER_ROUTE.path.test(path);
}

export function isLocalVmViewerUpgrade(path: string): boolean {
  return LOCAL_VM_VIEWER_ROUTE.path.test(path.split("?")[0] ?? "");
}

export function localVmViewerBotId(path: string): string | null {
  const match = /^\/api\/bots\/([\w-]+)\/local-computer\/viewer/.exec(path.split("?")[0] ?? "");
  return match?.[1] ?? null;
}

export function isLocalVmPhoneSurface(method: string, path: string): boolean {
  return (
    isLocalVmStatus(method, path)
    || isLocalVmAction(method, path)
    || isLocalVmScreenshot(method, path)
    || isLocalVmJoin(method, path)
    || isLocalVmInput(method, path)
    || isLocalVmViewer(method, path)
  );
}

/** Paired-safe computer destination. The broad bot PATCH stays closed; this
 * route accepts only where the bot's computer lives. The sidecar rewrites it
 * onto the harness's existing bot PATCH so official desktops keep working. */
export const COMPUTER_DESTINATION_ROUTE = {
  method: "PATCH",
  path: /^\/api\/bots\/[\w-]+\/computer-destination$/,
} as const;

export function isComputerDestination(method: string, path: string): boolean {
  return method === COMPUTER_DESTINATION_ROUTE.method && COMPUTER_DESTINATION_ROUTE.path.test(path);
}

/** App-wide permission policy. The sidecar exposes only this small setting,
 * never the broader `/api/config` writer. */
export const PERMISSION_POLICY_ROUTE = {
  method: "PATCH",
  path: /^\/api\/permissions$/,
} as const;
export const PERMISSION_POLICY_STATUS_ROUTE = {
  method: "GET",
  path: /^\/api\/permissions$/,
} as const;
export const BOT_PERMISSION_MODE_ROUTE = {
  method: "PATCH",
  path: /^\/api\/bots\/[\w-]+\/permission-mode$/,
} as const;
const PERMISSION_MODES = new Set(["ask", "allow", "deny"]);
const APPROVAL_REVIEWER_MODES = new Set(["off", "when-unclear", "always"]);

export function isPermissionPolicy(method: string, path: string): boolean {
  return PERMISSION_POLICY_ROUTE.method === method && PERMISSION_POLICY_ROUTE.path.test(path);
}
export function isPermissionPolicyStatus(method: string, path: string): boolean {
  return PERMISSION_POLICY_STATUS_ROUTE.method === method && PERMISSION_POLICY_STATUS_ROUTE.path.test(path);
}
export function isBotPermissionMode(method: string, path: string): boolean {
  return BOT_PERMISSION_MODE_ROUTE.method === method && BOT_PERMISSION_MODE_ROUTE.path.test(path);
}

export const APPROVAL_REVIEWER_STATUS_ROUTE = {
  method: "GET",
  path: /^\/api\/approval-reviewer$/,
} as const;
export const APPROVAL_REVIEWER_ROUTE = {
  method: "PUT",
  path: /^\/api\/approval-reviewer$/,
} as const;

export function isApprovalReviewerStatus(method: string, path: string): boolean {
  return APPROVAL_REVIEWER_STATUS_ROUTE.method === method && APPROVAL_REVIEWER_STATUS_ROUTE.path.test(path);
}
export function isApprovalReviewer(method: string, path: string): boolean {
  return APPROVAL_REVIEWER_ROUTE.method === method && APPROVAL_REVIEWER_ROUTE.path.test(path);
}

export function validateApprovalReviewerBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: { mode: string; instanceId?: string; model?: string } } {
  if (!isApprovalReviewer(method, path)) return { patch: { mode: "" } };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "approval reviewer requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  const allowed = new Set(["mode", "instanceId", "model"]);
  const extra = keys.find((key) => !allowed.has(key));
  if (extra) {
    return { denial: { status: 400, error: `unsupported approval reviewer field: ${extra}` } };
  }
  if (typeof values.mode !== "string" || !APPROVAL_REVIEWER_MODES.has(values.mode)) {
    return { denial: { status: 400, error: "mode must be off, when-unclear, or always" } };
  }
  const patch: { mode: string; instanceId?: string; model?: string } = { mode: values.mode };
  if (values.instanceId !== undefined) {
    if (typeof values.instanceId !== "string" || values.instanceId.length < 1 || values.instanceId.length > 200) {
      return { denial: { status: 400, error: "instanceId must be a string" } };
    }
    patch.instanceId = values.instanceId;
  }
  if (values.model !== undefined) {
    if (typeof values.model !== "string" || values.model.length < 1 || values.model.length > 500) {
      return { denial: { status: 400, error: "model must be a string" } };
    }
    patch.model = values.model;
  }
  if ((patch.instanceId && !patch.model) || (!patch.instanceId && patch.model)) {
    return { denial: { status: 400, error: "instanceId and model must be set together" } };
  }
  return { patch };
}
export function botPermissionModeBotId(path: string): string | null {
  return /^\/api\/bots\/([\w-]+)\/permission-mode$/.exec(path)?.[1] ?? null;
}

export function validatePermissionPolicyBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: { defaultMode: string } } {
  if (!isPermissionPolicy(method, path)) return { patch: { defaultMode: "" } };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "permission policy requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== 1 || keys[0] !== "defaultMode") {
    return { denial: { status: 400, error: "permission policy accepts only defaultMode" } };
  }
  if (typeof values.defaultMode !== "string" || !PERMISSION_MODES.has(values.defaultMode)) {
    return { denial: { status: 400, error: "defaultMode must be ask, allow, or deny" } };
  }
  return { patch: { defaultMode: values.defaultMode } };
}

export function validateBotPermissionModeBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: { mode: string } } {
  if (!isBotPermissionMode(method, path)) return { patch: { mode: "" } };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "permission mode requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== 1 || keys[0] !== "mode") {
    return { denial: { status: 400, error: "permission mode accepts only mode" } };
  }
  if (typeof values.mode !== "string" || (values.mode !== "inherit" && !PERMISSION_MODES.has(values.mode))) {
    return { denial: { status: 400, error: "mode must be inherit, ask, allow, or deny" } };
  }
  return { patch: { mode: values.mode } };
}

/** Paired-safe group instructions and default responder. Rewrites to harness
 * PATCH /api/groups/:id with only bulletin and defaultResponder. */
export const GROUP_SETUP_ROUTE = {
  method: "PATCH",
  path: /^\/api\/groups\/[\w-]+\/setup$/,
} as const;

export function isGroupSetup(method: string, path: string): boolean {
  return method === GROUP_SETUP_ROUTE.method && GROUP_SETUP_ROUTE.path.test(path);
}

export function groupSetupRoomId(path: string): string | null {
  const match = /^\/api\/groups\/([\w-]+)\/setup$/.exec(path);
  return match?.[1] ?? null;
}

/** Hide or unhide a bot from the roster without reaching execution policy. */
export const BOT_VISIBILITY_ROUTE = {
  method: "PATCH",
  path: /^\/api\/bots\/[\w-]+\/visibility$/,
} as const;

export function isBotVisibility(method: string, path: string): boolean {
  return method === BOT_VISIBILITY_ROUTE.method && BOT_VISIBILITY_ROUTE.path.test(path);
}

export function botVisibilityBotId(path: string): string | null {
  const match = /^\/api\/bots\/([\w-]+)\/visibility$/.exec(path);
  return match?.[1] ?? null;
}

export const BOT_UNREAD_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/unread$/,
} as const;

export const GROUP_UNREAD_ROUTE = {
  method: "POST",
  path: /^\/api\/groups\/[\w-]+\/unread$/,
} as const;

export function isBotUnread(method: string, path: string): boolean {
  return method === BOT_UNREAD_ROUTE.method && BOT_UNREAD_ROUTE.path.test(path);
}

export function isGroupUnread(method: string, path: string): boolean {
  return method === GROUP_UNREAD_ROUTE.method && GROUP_UNREAD_ROUTE.path.test(path);
}

export function botUnreadBotId(path: string): string | null {
  const match = /^\/api\/bots\/([\w-]+)\/unread$/.exec(path);
  return match?.[1] ?? null;
}

export function groupUnreadRoomId(path: string): string | null {
  const match = /^\/api\/groups\/([\w-]+)\/unread$/.exec(path);
  return match?.[1] ?? null;
}

export function validateGroupSetupBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: Record<string, unknown> } {
  if (!isGroupSetup(method, path)) return { patch: {} };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "group setup requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  const allowed = new Set(["bulletin", "defaultResponder"]);
  const extra = keys.find((key) => !allowed.has(key));
  if (extra) {
    return { denial: { status: 400, error: `unsupported group setup field: ${extra}` } };
  }
  if (!keys.length) {
    return { denial: { status: 400, error: "group setup requires bulletin and/or defaultResponder" } };
  }
  const patch: Record<string, unknown> = {};
  if (values.bulletin !== undefined) {
    if (typeof values.bulletin !== "string") {
      return { denial: { status: 400, error: "bulletin must be a string" } };
    }
    if (values.bulletin.length > 12_000) {
      return { denial: { status: 400, error: "bulletin must be at most 12000 characters" } };
    }
    patch.bulletin = values.bulletin;
  }
  if (values.defaultResponder !== undefined) {
    const value = values.defaultResponder as { kind?: unknown; botId?: unknown } | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { denial: { status: 400, error: "invalid default responder" } };
    }
    if (value.kind === "everyone") patch.defaultResponder = { kind: "everyone" };
    else if (value.kind === "mentions") patch.defaultResponder = { kind: "mentions" };
    else if (value.kind === "member" && typeof value.botId === "string" && /^[\w-]+$/.test(value.botId)) {
      patch.defaultResponder = { kind: "member", botId: value.botId };
    } else {
      return { denial: { status: 400, error: "invalid default responder" } };
    }
  }
  return { patch };
}

export function validateBotVisibilityBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: Record<string, unknown> } {
  if (!isBotVisibility(method, path)) return { patch: {} };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "visibility requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== 1 || keys[0] !== "hidden") {
    return { denial: { status: 400, error: "visibility accepts only hidden" } };
  }
  if (typeof values.hidden !== "boolean") {
    return { denial: { status: 400, error: "hidden must be true or false" } };
  }
  return { patch: { hidden: values.hidden } };
}

const COMPUTER_DESTINATIONS = new Set(["cloud", "vm", "local", "off"]);
const CLOUD_BACKENDS = new Set(["box", "vps"]);

export function computerDestinationBotId(path: string): string | null {
  const match = /^\/api\/bots\/([\w-]+)\/computer-destination$/.exec(path);
  return match?.[1] ?? null;
}

/** Paired-safe model switch. Instance + model stay catalog-checked on the
 * harness `/model` route. An explicit `effort` key is rewritten onto the
 * existing bot PATCH as `modelSelection`, because the live desktop harness
 * still rejects effort on `/model`. Extra keys stay refused. */
export const BOT_MODEL_ROUTE = {
  method: "PATCH",
  path: /^\/api\/bots\/[\w-]+\/model$/,
} as const;

const EFFORT_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function isBotModel(method: string, path: string): boolean {
  return method === BOT_MODEL_ROUTE.method && BOT_MODEL_ROUTE.path.test(path);
}

export function botModelBotId(path: string): string | null {
  const match = /^\/api\/bots\/([\w-]+)\/model$/.exec(path);
  return match?.[1] ?? null;
}

export function validateBotModelBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: { instanceId: string; model: string; effort?: string | null }; rewrite: boolean } {
  if (!isBotModel(method, path)) return { patch: { instanceId: "", model: "" }, rewrite: false };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "model requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  const allowed = new Set(["instanceId", "model", "effort"]);
  const extra = keys.find((key) => !allowed.has(key));
  if (extra) {
    return { denial: { status: 400, error: `unsupported model field: ${extra}` } };
  }
  const instanceId = values.instanceId;
  const model = values.model;
  if (typeof instanceId !== "string" || instanceId.length < 1 || instanceId.length > 200) {
    return { denial: { status: 400, error: "instanceId must be a string" } };
  }
  if (typeof model !== "string" || model.length < 1 || model.length > 500) {
    return { denial: { status: 400, error: "model must be a string" } };
  }
  const patch: { instanceId: string; model: string; effort?: string | null } = { instanceId, model };
  if (!Object.prototype.hasOwnProperty.call(values, "effort")) {
    return { patch, rewrite: false };
  }
  const effort = values.effort;
  if (effort === null) {
    patch.effort = null;
    return { patch, rewrite: true };
  }
  if (typeof effort !== "string" || !EFFORT_LEVELS.has(effort)) {
    return { denial: { status: 400, error: "effort must be a recognized reasoning level" } };
  }
  patch.effort = effort;
  return { patch, rewrite: true };
}

/** Strip the destination patch down to the fields the harness already
 * accepts on PATCH /api/bots/:id. Extra keys are refused here so a paired
 * token cannot smuggle execution-policy or credential fields through the
 * rewrite. */
export function validateComputerDestinationBody(
  method: string,
  path: string,
  body: unknown,
): { denial: Denial } | { patch: Record<string, unknown> } {
  if (!isComputerDestination(method, path)) return { patch: {} };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { denial: { status: 400, error: "computer destination requires a JSON object" } };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  const allowed = new Set(["computer", "acknowledgeLocalAuto", "cloudBackend"]);
  const extra = keys.find((key) => !allowed.has(key));
  if (extra) {
    return { denial: { status: 400, error: `unsupported computer destination field: ${extra}` } };
  }
  const computer = values.computer;
  if (typeof computer !== "string" || !COMPUTER_DESTINATIONS.has(computer)) {
    return { denial: { status: 400, error: "computer must be cloud, vm, local, or off" } };
  }
  const patch: Record<string, unknown> = { computer };
  if (values.acknowledgeLocalAuto !== undefined) {
    if (typeof values.acknowledgeLocalAuto !== "boolean") {
      return { denial: { status: 400, error: "acknowledgeLocalAuto must be true or false" } };
    }
    if (computer === "local") patch.acknowledgeLocalAuto = values.acknowledgeLocalAuto;
  }
  if (values.cloudBackend !== undefined) {
    if (typeof values.cloudBackend !== "string" || !CLOUD_BACKENDS.has(values.cloudBackend)) {
      return { denial: { status: 400, error: "cloudBackend must be box or vps" } };
    }
    if (computer === "cloud") patch.cloudBackend = values.cloudBackend;
  }
  return { patch };
}

/** Local VM mutations have no caller-controlled fields. Requiring exactly
 * `{}` at the sidecar boundary prevents a future harness field from turning
 * this phone-safe route into arbitrary lifecycle or command execution. */
export function validateLocalVmActionBody(
  method: string,
  path: string,
  body: unknown,
): Denial | null {
  if (!isLocalVmAction(method, path) && !isLocalVmScreenshot(method, path) && !isLocalVmJoin(method, path)) {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return { status: 400, error: "Local VM actions accept an empty JSON object only" };
  }
  return null;
}

/** Inline OAuth cards are narrower than the general connected-app catalog.
 * The phone may act only on a card already present in the exact transcript it
 * names; it cannot add arbitrary accounts from a copied slug. */
export const CONNECTOR_CARD_STATUS_ROUTE = {
  method: "GET",
  path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/,
} as const;

export const CONNECTOR_CARD_ACTION_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:authorize|resume|dismiss)$/,
} as const;

export function isConnectorCardStatus(method: string, path: string): boolean {
  return method === CONNECTOR_CARD_STATUS_ROUTE.method && CONNECTOR_CARD_STATUS_ROUTE.path.test(path);
}

export function isConnectorCardAction(method: string, path: string): boolean {
  return method === CONNECTOR_CARD_ACTION_ROUTE.method && CONNECTOR_CARD_ACTION_ROUTE.path.test(path);
}

/** Validate the only body a connector-card mutation accepts. Keeping this at
 * the companion boundary prevents a paired token from forwarding arbitrary
 * fields such as aliases, credentials, or config paths to a future harness. */
export function validateConnectorCardBody(
  method: string,
  path: string,
  body: unknown,
): Denial | null {
  if (!isConnectorCardAction(method, path)) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, error: "connector card requests require a JSON body with threadId" };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length !== 1 || keys[0] !== "threadId") {
    return { status: 400, error: "connector card requests accept only threadId" };
  }
  const threadId = values.threadId;
  if (typeof threadId !== "string" || !/^[\w-]{1,200}$/.test(threadId)) {
    return { status: 400, error: "threadId must be a safe conversation identifier" };
  }
  return null;
}

/** The status action has no body; its one query value is validated separately
 * by the proxy because `denyReason` intentionally receives a path only. */
export function validateConnectorCardThreadId(threadId: unknown): Denial | null {
  if (typeof threadId !== "string" || !/^[\w-]{1,200}$/.test(threadId)) {
    return { status: 400, error: "threadId must be a safe conversation identifier" };
  }
  return null;
}

/** Every request the iOS app makes, and nothing else.
 *
 * Ids are `[\w-]+`, matching the harness's own route patterns. The paths
 * arrive undecoded and are anchored at both ends, so an encoded traversal
 * fails to match and is denied rather than forwarded — the failure mode of
 * a strict pattern is a closed door, which is the one to have. */
const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  // configured-or-not booleans. The write side is refused below: reading
  // which providers are set up is not reading their keys.
  { method: "GET", path: /^\/api\/config$/ },
  PERMISSION_POLICY_STATUS_ROUTE,
  PERMISSION_POLICY_ROUTE,
  APPROVAL_REVIEWER_STATUS_ROUTE,
  APPROVAL_REVIEWER_ROUTE,
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },
  HERMES_SETUP_STATUS_ROUTE,
  HERMES_SETUP_CONNECT_ROUTE,
  HERMES_SETUP_SIGNIN_ROUTE,
  { method: "GET", path: /^\/api\/vbot\/engine-sync$/ },
  { method: "PATCH", path: /^\/api\/vbot\/primary-engine$/ },
  { method: "GET", path: /^\/api\/vbot\/bots$/ },
  { method: "GET", path: /^\/api\/vbot\/groups$/ },
  { method: "GET", path: /^\/api\/vbot\/providers$/ },
  { method: "GET", path: /^\/api\/vbot\/router$/ },
  { method: "PUT", path: /^\/api\/vbot\/router$/ },
  { method: "GET", path: /^\/api\/vbot\/bots\/[\w.-]+\/activity$/ },
  { method: "POST", path: /^\/api\/vbot\/bots\/[\w.-]+\/turns$/ },
  { method: "POST", path: /^\/api\/vbot\/bots\/[\w.-]+\/steer$/ },
  { method: "POST", path: /^\/api\/vbot\/bots\/[\w.-]+\/stop$/ },
  // Sidecar-owned, authenticated endpoint metadata. The proxy terminates it
  // locally; it never becomes a newly exposed harness route.
  { method: "GET", path: /^\/api\/companion\/endpoints$/ },
  { method: "POST", path: /^\/api\/pairing-invitations$/ },
  { method: "POST", path: /^\/api\/web-pairing\/requests\/[A-Za-z0-9_-]{22,128}\/approve$/ },

  // the fleet, and making a bot
  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  // answering a 1:1 approval card — the per-bot twin of the threads
  // respond route. Granting "always allow" stays on the narrow
  // always-allow route; the broad bot PATCH remains closed.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // Pinning is a purpose-built mutation. The broad bot PATCH remains closed
  // so a paired token cannot change execution policy or credentials.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/pin$/ },
  BOT_VISIBILITY_ROUTE,
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/unread$/ },
  // Paired-safe profile subset. The harness route itself rejects fields
  // outside identity, avatar, notifications, and voice preferences.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  BOT_PERMISSION_MODE_ROUTE,
  // Paired-safe model switch. Instance and model are validated against the
  // advertised catalog on the harness; the broad bot PATCH stays closed.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/model$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/runtime-binding$/ },
  { method: "POST", path: /^\/api\/hermes\/subagents\/[\w-]+\/promote$/ },
  COMPUTER_DESTINATION_ROUTE,
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // Full cloud desktop access. The route is narrow and the proxy applies a
  // second, per-device capability check before it reaches the harness.
  CLOUD_DESKTOP_JOIN_ROUTE,

  // Local VM status, a read-only desktop capture, and narrowly guarded
  // per-bot lifecycle. Shared image/runtime setup and arbitrary exec stay
  // desktop-only.
  LOCAL_VM_STATUS_ROUTE,
  LOCAL_VM_ACTION_ROUTE,
  LOCAL_VM_SCREENSHOT_ROUTE,
  LOCAL_VM_JOIN_ROUTE,
  LOCAL_VM_INPUT_ROUTE,
  LOCAL_VM_VIEWER_ROUTE,

  // rooms — making one, and talking in one
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/pin$/ },
  GROUP_SETUP_ROUTE,
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/unread$/ },

  // a transcript, its images, and answering an approval
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { method: "GET", path: /^\/api\/search$/ },

  // App-owned profile images. Upload is image-only and capped at 10 MB by
  // the harness; GET is a single bare generated filename, never a path.
  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp|mp4|mov)$/i },

  // Renderer-neutral voice operations. Neither route reads or writes the
  // workspace ElevenLabs key; the phone receives labels or audio only.
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },

  // Routines create ordinary tasks using an existing agent configuration.
  // Webhook management remains explicitly denied below.
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },

  // Scrubbed bridge roster + revoke. Job audit/cancel stay off this list.
  { method: "GET", path: /^\/api\/bridges$/ },
  { method: "DELETE", path: /^\/api\/bridges\/[\w-]+$/ },

  // Multi-account Composio management exposes opaque ids and aliases only.
  // Revocation stays on the Mac: the account DELETE route is deliberately
  // absent — a paired phone can see and add accounts, never remove one.
  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },
  { method: "POST", path: /^\/api\/connectors\/[\w-]+\/authorize$/ },
  CONNECTOR_CARD_STATUS_ROUTE,
  CONNECTOR_CARD_ACTION_ROUTE,
];

/** Route families worth naming in the refusal.
 *
 * Everything not allowed is denied either way; this only decides whether the
 * person gets a sentence or a 404. These are the ones someone might
 * reasonably expect to work from the phone, where "no route" would read as a
 * bug in the companion rather than a decision about where host configuration
 * happens. Order matters only in that the first match wins. */
const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    // Losing the phone must not mean losing the ability to lock it out.
    error: "Phone settings are managed on your computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  { path: /^\/api\/instances(\/|$)/, error: "custom ACP/MCP engines are configured on your computer" },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    path: /^\/api\/bots\/[\w-]+\/local-computer(\/|$)/,
    error: "Local VM access is managed per phone in OpenMausBot → Settings → Companion",
  },
  {
    // Creating one exposes an endpoint to the internet, and rotating a
    // secret breaks whatever was sending to it. Neither belongs on a device
    // that lives in a pocket.
    path: /^\/api\/webhooks(\/|$)/,
    error: "webhooks are set up on your computer",
  },
  { path: /^\/api\/connectors(\/|$)/, error: "connected apps are set up on your computer" },
  {
    path: /^\/api\/routines(\/|$)/,
    error: "this routine operation is only available on your computer",
  },
  { path: /^\/api\/teams(\/|$)/, error: "teams are imported and exported on your computer" },
];

/** Bridge daemon routes that must reach the harness over the public URL.
 *
 * Exact paths, not a `/api/bridge/` prefix: job audit, cancel, and pairing
 * are harness-loopback operator surfaces and must not traverse the sidecar. */
export function isBridgeDaemonRoute(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (
      path === "/api/bridge/register"
      || path === "/api/bridge/heartbeat"
      || path === "/api/bridge/result"
      || path === "/api/bridge/hermes-tools"
    )
  );
}

const WEB_PAIRING_ID = "([A-Za-z0-9_-]{22,128})";
const WEB_PAIRING_REGISTER = /^\/api\/web-pairing\/requests$/;
const WEB_PAIRING_APPROVE = new RegExp(`^/api/web-pairing/requests/${WEB_PAIRING_ID}/approve$`);
const WEB_PAIRING_REDEEM = new RegExp(`^/api/web-pairing/requests/${WEB_PAIRING_ID}/redeem$`);
const WEB_PAIRING_CANCEL = new RegExp(`^/api/web-pairing/requests/${WEB_PAIRING_ID}$`);

export type WebPairingRoute =
  | { action: "register" }
  | { action: "approve"; requestId: string }
  | { action: "redeem"; requestId: string }
  | { action: "cancel"; requestId: string };

export function matchWebPairingRoute(method: string, path: string): WebPairingRoute | null {
  if (method === "POST" && WEB_PAIRING_REGISTER.test(path)) return { action: "register" };
  if (method === "POST") {
    const approve = path.match(WEB_PAIRING_APPROVE);
    if (approve?.[1]) return { action: "approve", requestId: approve[1] };
    const redeem = path.match(WEB_PAIRING_REDEEM);
    if (redeem?.[1]) return { action: "redeem", requestId: redeem[1] };
  }
  if (method === "DELETE") {
    const cancel = path.match(WEB_PAIRING_CANCEL);
    if (cancel?.[1]) return { action: "cancel", requestId: cancel[1] };
  }
  return null;
}

export function isPublicWebPairingRoute(method: string, path: string): boolean {
  const route = matchWebPairingRoute(method, path);
  return route?.action === "register" || route?.action === "redeem" || route?.action === "cancel";
}

export function isWebPairingApproveRoute(method: string, path: string): boolean {
  return matchWebPairingRoute(method, path)?.action === "approve";
}

/** Why this request may not go through, or null when it may.
 *
 * Default deny: the answer for anything not on the list is "no route", which
 * is what keeps a stolen token from mapping the API. An allowlist rather than
 * a blocklist is the property this whole module exists for, and the one that
 * quietly stopped being true once before. */
export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  // Pairing is the one thing a device does before it has a credential.
  if (method === "POST" && path === "/api/pair") return null;
  if (isPublicWebPairingRoute(method, path)) return null;
  // Liveness is the other: it exists to be the first thing anyone curls when
  // pairing will not work, and behind the token check it answered 401 to
  // exactly the person it was for — which reads as "broken" rather than
  // "unpaired". It discloses nothing a port scan would not.
  if (method === "GET" && path === "/api/health") return null;
  if (isBridgeDaemonRoute(method, path)) return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from Phone settings in OpenMausBot on your computer" };
  }

  if (ALLOWED.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  // Everything else, including routes the harness really does have. Saying
  // "no route" rather than "not allowed" keeps the sidecar from enumerating
  // the API to anyone holding a stolen token — and it is what the peer-agent
  // endpoints under /api/internal/ always got, since off this machine they
  // genuinely do not exist.
  return { status: 404, error: `no route: ${method} ${path}` };
}
