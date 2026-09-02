import {
  ControlPlaneError,
  createControlPlaneClient,
  decodeFleetResponse,
  normalizeControlPlaneURL,
// @ts-expect-error shared runtime module has no generated types
} from "../../shared/control-plane-client.mjs";
import { clearClientCookie, getClientCookie, setClientCookie } from "./web-client-cookies";
import { isWebClientMode, webClientSearch } from "./web-client-mode";

const HUB_URL_COOKIE = "vbot_w_hub";
const HUB_NAME_COOKIE = "vbot_w_hub_name";
const HUB_MAX_AGE = 365 * 24 * 60 * 60;
const DEFAULT_CONTROL_PLANE = "https://accounts.openmausbot.com";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface WebAccountUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

export interface WebFleetInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: string;
  runtimeProfile: string;
  appVersion: string | null;
  capabilities: string[];
  lastSeenAt: number | null;
  online: boolean;
  endpoint: { url: string; status: string } | null;
}

export interface WebHubConnection {
  baseUrl: string;
  deviceToken: string;
  deviceName: string;
}

export interface WebClientSessionSnapshot {
  account: WebAccountUser | null;
  accountToken: string | null;
  fleet: WebFleetInstallation[];
  hub: WebHubConnection | null;
  controlPlaneUrl: string;
  pocketIdEnabled: boolean;
}

let hubApiBase = "";
let hubDeviceToken: string | null = null;
let accountTokenMemory: string | null = null;

function isAllowedControlPlaneOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return false;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    if (origin === DEFAULT_CONTROL_PLANE) return true;
    return loopback;
  } catch {
    return false;
  }
}

export function resolveControlPlaneUrl(search = globalThis.location?.search ?? ""): string {
  const override = new URLSearchParams(search).get("controlPlane");
  if (override) {
    const normalized = normalizeControlPlaneURL(override);
    if (normalized && isAllowedControlPlaneOrigin(normalized)) return normalized;
  }
  return DEFAULT_CONTROL_PLANE;
}

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

export function setAccountToken(token: string | null) {
  accountTokenMemory = token;
}

export function getAccountToken(): string | null {
  return accountTokenMemory;
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

export function assertAccountDiscoveryOnly(path: string, search = webClientSearch()): void {
  if (!isWebClientMode(search)) return;
  if (!accountDiscoveryOnly(path, search)) {
    throw new Error("Complete hub pairing before using the hub API.");
  }
}

function readStoredHubUrl(): string | null {
  const baseUrl = getClientCookie(HUB_URL_COOKIE);
  if (!baseUrl) return null;
  return normalizeHubBaseUrl(baseUrl);
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

export function persistAccountSession(token: string) {
  setAccountToken(token);
}

export function clearAccountSession() {
  setAccountToken(null);
}

export function persistHubConnection(connection: WebHubConnection) {
  setClientCookie(HUB_URL_COOKIE, connection.baseUrl, HUB_MAX_AGE);
  setClientCookie(HUB_NAME_COOKIE, connection.deviceName, HUB_MAX_AGE);
  setHubApiBase(connection.baseUrl);
  setHubDeviceToken(connection.deviceToken);
}

export function clearHubConnection() {
  clearClientCookie(HUB_URL_COOKIE);
  clearClientCookie(HUB_NAME_COOKIE);
  setHubApiBase("");
  setHubDeviceToken(null);
}

export function pocketIdCallbackURL(controlPlaneUrl: string, returnTo: string): string {
  const base = controlPlaneUrl.replace(/\/$/, "");
  return `${base}/web-client/complete?redirect=${encodeURIComponent(returnTo)}`;
}

export function consumeWebAuthCodeFromLocation(): string | null {
  try {
    const search = globalThis.location?.search ?? "";
    const params = new URLSearchParams(search);
    const code = params.get("web_auth_code");
    if (!code) return null;
    params.delete("web_auth_code");
    params.delete("auth_error");
    const nextSearch = params.toString();
    const next = `${globalThis.location?.pathname ?? "/"}${nextSearch ? `?${nextSearch}` : ""}`;
    globalThis.history?.replaceState?.(null, "", next);
    return code;
  } catch {
    return null;
  }
}

export async function exchangeWebAuthCode(baseURL: string, code: string): Promise<string> {
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/web-client/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: globalThis.location?.origin ?? baseURL },
    body: JSON.stringify({ code }),
  });
  const payload = (await response.json().catch(() => null)) as { accountToken?: string; error?: string } | null;
  if (!response.ok || typeof payload?.accountToken !== "string") {
    throw new ControlPlaneError(payload?.error ?? "request_failed", response.status);
  }
  persistAccountSession(payload.accountToken);
  return payload.accountToken;
}

export async function bootstrapWebClientAuth(baseURL: string) {
  const code = consumeWebAuthCodeFromLocation();
  if (!code) return null;
  return exchangeWebAuthCode(baseURL, code);
}

export function loadWebClientSession(search = globalThis.location?.search ?? ""): WebClientSessionSnapshot {
  const controlPlaneUrl = resolveControlPlaneUrl(search);
  const hubUrl = readStoredHubUrl();
  if (hubUrl) setHubApiBase(hubUrl);
  const hub = hubDeviceToken && hubApiBase
    ? {
        baseUrl: hubApiBase,
        deviceToken: hubDeviceToken,
        deviceName: getClientCookie(HUB_NAME_COOKIE) ?? "Web client",
      }
    : null;
  return {
    account: null,
    accountToken: accountTokenMemory,
    fleet: [],
    hub,
    controlPlaneUrl,
    pocketIdEnabled: false,
  };
}

export function createWebControlPlaneClient(baseURL: string) {
  return createControlPlaneClient({ baseURL });
}

export async function requestAccountOtp(baseURL: string, email: string) {
  const client = createWebControlPlaneClient(baseURL);
  return client.requestOTP(email);
}

export async function verifyAccountOtp(baseURL: string, email: string, otp: string) {
  const client = createWebControlPlaneClient(baseURL);
  const result = await client.verifyOTP(email, otp);
  persistAccountSession(result.accountToken);
  return result;
}

export async function fetchAccountUser(baseURL: string, accountToken: string): Promise<WebAccountUser> {
  const client = createWebControlPlaneClient(baseURL);
  const user = await client.me(accountToken);
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    emailVerified: user.emailVerified,
  };
}

export async function fetchFleet(baseURL: string, accountToken: string): Promise<WebFleetInstallation[]> {
  const client = createWebControlPlaneClient(baseURL);
  const installations = await client.listFleet(accountToken);
  return installations.map((installation: {
    id: string;
    clientInstanceId: string;
    name: string;
    platform: string;
    runtimeProfile: string;
    appVersion: string | null;
    capabilities: readonly string[];
    lastSeenAt: number | null;
    online: boolean;
    endpoint: { url: string; status: string } | null;
  }) => ({
    id: installation.id,
    clientInstanceId: installation.clientInstanceId,
    name: installation.name,
    platform: installation.platform,
    runtimeProfile: installation.runtimeProfile,
    appVersion: installation.appVersion,
    capabilities: [...installation.capabilities],
    lastSeenAt: installation.lastSeenAt,
    online: installation.online,
    endpoint: installation.endpoint
      ? { url: installation.endpoint.url, status: installation.endpoint.status }
      : null,
  }));
}

export async function probePocketId(baseURL: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL },
      body: JSON.stringify({ provider: "pocketid", callbackURL: globalThis.location?.origin ?? baseURL }),
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as { url?: string } | null;
    return typeof payload?.url === "string" && payload.url.startsWith("http");
  } catch {
    return false;
  }
}

export async function startPocketIdSignIn(baseURL: string, callbackURL: string): Promise<string> {
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ provider: "pocketid", callbackURL }),
  });
  const payload = (await response.json().catch(() => null)) as { url?: string } | null;
  if (!response.ok || typeof payload?.url !== "string") {
    throw new ControlPlaneError("request_failed", response.status);
  }
  return payload.url;
}

export interface PairDirectInput {
  baseUrl: string;
  credential: string;
  deviceName: string;
  pairRequestId?: string;
}

export async function pairDirectHub(input: PairDirectInput): Promise<WebHubConnection> {
  const baseUrl = normalizeHubBaseUrl(input.baseUrl);
  if (!baseUrl) throw new Error("Enter a valid hub address.");
  const body = JSON.stringify({
    credential: input.credential,
    deviceName: input.deviceName,
    pairRequestId: input.pairRequestId,
  });
  const response = await fetch(`${baseUrl}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    device?: { name?: string };
  };
  if (!response.ok || typeof payload.token !== "string") {
    throw new Error(payload.error ?? "Pairing could not finish.");
  }
  const connection: WebHubConnection = {
    baseUrl,
    deviceToken: payload.token,
    deviceName: payload.device?.name ?? input.deviceName,
  };
  persistHubConnection(connection);
  return connection;
}

export function accountDiscoveryOnly(path: string, search = webClientSearch()): boolean {
  if (!isWebClientMode(search)) return false;
  return path === "/v1/me" || path === "/v1/fleet" || path.startsWith("/api/auth/") || path === "/web-client/exchange";
}

export function decodeFleetPayload(payload: unknown): WebFleetInstallation[] | null {
  const installations = decodeFleetResponse(payload);
  if (!installations) return null;
  return installations.map((installation: {
    id: string;
    clientInstanceId: string;
    name: string;
    platform: string;
    runtimeProfile: string;
    appVersion: string | null;
    capabilities: readonly string[];
    lastSeenAt: number | null;
    online: boolean;
    endpoint: { url: string; status: string } | null;
  }) => ({
    id: installation.id,
    clientInstanceId: installation.clientInstanceId,
    name: installation.name,
    platform: installation.platform,
    runtimeProfile: installation.runtimeProfile,
    appVersion: installation.appVersion,
    capabilities: [...installation.capabilities],
    lastSeenAt: installation.lastSeenAt,
    online: installation.online,
    endpoint: installation.endpoint
      ? { url: installation.endpoint.url, status: installation.endpoint.status }
      : null,
  }));
}
