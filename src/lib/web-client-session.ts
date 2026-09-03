import { clearClientCookie, getClientCookie, setClientCookie } from "./web-client-cookies";

const HUB_URL_COOKIE = "vbot_w_hub";
const HUB_NAME_COOKIE = "vbot_w_hub_name";
const HUB_MAX_AGE = 365 * 24 * 60 * 60;
const DEVICE_TOKEN_STORAGE_KEY = "vbot_w_device_token";

/**
 * The hosted V Bot hub. Client and hub are deliberately different origins —
 * the web client ships from vbot.posival.com while the hub answers on
 * hub-vbot.posival.com — so the pairing form defaults to the hub rather than
 * to the page origin. The field stays editable for self-hosted hubs.
 */
export const DEFAULT_WEB_HUB_URL = "https://hub-vbot.posival.com";

/** The device row the hub returns from POST /api/pair. */
export interface WebHubDevice {
  id: string;
  name: string;
  createdAt: number | string | null;
  lastSeenAt: number | string | null;
  cloudDesktopAccess: boolean;
  localVmAccess: boolean;
}

export interface WebHubConnection {
  baseUrl: string;
  deviceToken: string;
  deviceName: string;
  /** The paired device record, kept whole for a later "paired devices" view. */
  device: WebHubDevice | null;
}

export interface WebClientSessionSnapshot {
  hub: WebHubConnection | null;
}

let hubApiBase = "";
let hubDeviceToken: string | null = null;
let hubDevice: WebHubDevice | null = null;

export function setHubApiBase(base: string) {
  hubApiBase = base.replace(/\/$/, "");
}

export function getHubApiBase(): string {
  return hubApiBase;
}

export function setHubDeviceToken(token: string | null) {
  hubDeviceToken = token;
}

export function getHubDeviceToken(): string | null {
  return hubDeviceToken;
}

/** The paired device record. Memory only, like the device token itself. */
export function getHubDevice(): WebHubDevice | null {
  return hubDevice;
}

export function hubApiUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${hubApiBase}${path}`;
}

export function canCallHubApi(): boolean {
  return Boolean(hubDeviceToken && hubApiBase);
}

export function assertHubApiReady(): void {
  if (!canCallHubApi()) {
    throw new Error("Complete hub pairing before using the hub API.");
  }
}

function readStoredHubUrl(): string | null {
  const baseUrl = getClientCookie(HUB_URL_COOKIE);
  if (!baseUrl) return null;
  return normalizeHubBaseUrl(baseUrl);
}

/**
 * The device token is the one secret in a web session, so it stays out of the
 * cookie jar the page sends on every request — the cookies carry only the hub
 * URL and device name, and the token waits in localStorage behind the hub
 * origin it was paired against.
 */
interface StoredDeviceToken {
  baseUrl: string;
  token: string;
}

function readStoredDeviceToken(baseUrl: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = JSON.parse(
      localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY) ?? "null",
    ) as Partial<StoredDeviceToken> | null;
    if (stored?.baseUrl !== baseUrl || typeof stored.token !== "string" || !stored.token) return null;
    return stored.token;
  } catch {
    return null;
  }
}

function writeStoredDeviceToken(baseUrl: string, token: string) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, JSON.stringify({ baseUrl, token }));
  } catch {
    // A private window can refuse writes; the session then stays memory-only.
  }
}

function clearStoredDeviceToken() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
}

export function normalizeHubBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** What the pairing form pre-fills as the hub address. */
export function defaultWebHubUrl(hostname?: string): string {
  // No argument is the web form default. Keep the explicit hostname behavior
  // for callers/tests that want to distinguish the hosted client from local preview.
  if (hostname === undefined || hostname === "vbot.posival.com") return DEFAULT_WEB_HUB_URL;
  return "";
}

/**
 * Bot records carry avatars as the hub-relative `/api/attachments/<file>`.
 * The browser client runs on a different origin than the hub, so the bare
 * filename is re-hung off the paired hub's API base; on desktop, where the
 * base is empty, this is the same same-origin path as before. Only names the
 * attachment server itself could have generated resolve, so a hostile bot
 * record cannot turn into an arbitrary remote or script-capable image.
 */
export function hubAttachmentUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const name = value.replaceAll("\\", "/").split("/").pop() ?? "";
  if (!/^[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp)$/.test(name)) return null;
  return hubApiUrl(`/api/attachments/${encodeURIComponent(name)}`);
}

export function persistHubConnection(connection: WebHubConnection) {
  setClientCookie(HUB_URL_COOKIE, connection.baseUrl, HUB_MAX_AGE);
  setClientCookie(HUB_NAME_COOKIE, connection.deviceName, HUB_MAX_AGE);
  setHubApiBase(connection.baseUrl);
  setHubDeviceToken(connection.deviceToken);
  writeStoredDeviceToken(connection.baseUrl, connection.deviceToken);
  hubDevice = connection.device;
}

export function clearHubConnection() {
  clearClientCookie(HUB_URL_COOKIE);
  clearClientCookie(HUB_NAME_COOKIE);
  clearStoredDeviceToken();
  setHubApiBase("");
  setHubDeviceToken(null);
  hubDevice = null;
}

export function loadWebClientSession(): WebClientSessionSnapshot {
  const hubUrl = readStoredHubUrl();
  if (hubUrl) {
    setHubApiBase(hubUrl);
    if (!hubDeviceToken) setHubDeviceToken(readStoredDeviceToken(hubUrl));
  }
  const hub = hubDeviceToken && hubApiBase
    ? {
        baseUrl: hubApiBase,
        deviceToken: hubDeviceToken,
        deviceName: getClientCookie(HUB_NAME_COOKIE) ?? "Web client",
        device: hubDevice,
      }
    : null;
  return { hub };
}

/** The hub's contract for `pairRequestId`. */
export const PAIR_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;

const PAIR_REQUEST_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";

export function isPairRequestId(value: string): boolean {
  return PAIR_REQUEST_ID_PATTERN.test(value);
}

/**
 * A client-generated idempotency key for one pairing attempt. The caller
 * holds it across retries of the same attempt and mints a fresh one only
 * when the user genuinely starts over, so a retried submit can never consume
 * a second slot on the hub's pairing window.
 */
export function createPairRequestId(length = 32): string {
  const size = Math.min(128, Math.max(16, Math.trunc(length)));
  const bytes = new Uint8Array(size);
  const source = globalThis.crypto;
  if (source?.getRandomValues) source.getRandomValues(bytes);
  else for (let index = 0; index < size; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let id = "";
  // 64-character alphabet, so the byte -> character fold stays unbiased.
  for (const byte of bytes) id += PAIR_REQUEST_ID_ALPHABET[byte % PAIR_REQUEST_ID_ALPHABET.length];
  return id;
}

/**
 * How the form should treat a refused pairing:
 * - `wrong-code`: retypeable mistake, same window still open.
 * - `window-closed`: the hub's pairing window is gone; only a new code helps.
 * - `device-limit`: nothing wrong with the code, the hub is full.
 * - `save-failed`: the hub could not persist the device.
 * - `unknown`: network trouble or a sentence we do not recognise.
 */
export type PairFailureKind =
  | "wrong-code"
  | "window-closed"
  | "device-limit"
  | "save-failed"
  | "unknown";

export function classifyPairFailure(message: string): PairFailureKind {
  const text = message.trim().toLowerCase();
  if (text.startsWith("no pairing is in progress")) return "window-closed";
  if (text.startsWith("too many incorrect codes")) return "window-closed";
  if (text.startsWith("that pairing credential is not right")) return "wrong-code";
  if (text.startsWith("too many paired devices")) return "device-limit";
  if (text.startsWith("could not save the pairing")) return "save-failed";
  return "unknown";
}

/**
 * A refused pairing. `fromHub` marks the sentences the hub itself wrote:
 * those are shown to the user verbatim, because they say more than any
 * wording this client could substitute.
 */
export class HubPairError extends Error {
  readonly kind: PairFailureKind;
  readonly fromHub: boolean;

  constructor(message: string, options: { kind?: PairFailureKind; fromHub?: boolean } = {}) {
    super(message);
    this.name = "HubPairError";
    this.fromHub = options.fromHub ?? false;
    this.kind = options.kind ?? (this.fromHub ? classifyPairFailure(message) : "unknown");
  }
}

export interface PairDirectInput {
  baseUrl: string;
  credential: string;
  deviceName: string;
  /** Optional per the hub, but always sent: it makes a retry idempotent. */
  pairRequestId?: string;
}

function normalizeHubDevice(value: unknown): WebHubDevice | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  const stamp = (input: unknown) =>
    typeof input === "number" || typeof input === "string" ? input : null;
  return {
    id: record.id,
    name: record.name,
    createdAt: stamp(record.createdAt),
    lastSeenAt: stamp(record.lastSeenAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
    localVmAccess: record.localVmAccess === true,
  };
}

export async function pairDirectHub(input: PairDirectInput): Promise<WebHubConnection> {
  const baseUrl = normalizeHubBaseUrl(input.baseUrl);
  if (!baseUrl) throw new HubPairError("Enter a valid hub address.");
  const pairRequestId =
    input.pairRequestId && isPairRequestId(input.pairRequestId) ? input.pairRequestId : undefined;
  const body = JSON.stringify({
    credential: input.credential,
    deviceName: input.deviceName,
    ...(pairRequestId ? { pairRequestId } : {}),
  });
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    throw new HubPairError("Could not reach that hub. Check the address and your connection.");
  }
  const payload = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    error?: unknown;
    device?: unknown;
  };
  if (!response.ok || typeof payload.token !== "string") {
    // The hub writes these sentences for people; pass them through untouched
    // and keep the generic wording for the cases it never spoke to.
    const hubMessage = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
    throw new HubPairError(hubMessage ?? "Pairing could not finish.", { fromHub: Boolean(hubMessage) });
  }
  const device = normalizeHubDevice(payload.device);
  const connection: WebHubConnection = {
    baseUrl,
    deviceToken: payload.token,
    deviceName: device?.name ?? input.deviceName,
    device,
  };
  persistHubConnection(connection);
  return connection;
}
