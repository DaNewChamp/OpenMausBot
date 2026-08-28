// Short-lived viewer tickets for WKWebView. A phone cannot attach a Bearer
// header to noVNC subresources or the WebSocket upgrade, so join mints a
// scoped token in the viewer URL query instead.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const TTL_MS = 30 * 60_000;

function secret(): Buffer {
  // Stable per companion data dir; not the device bearer secret.
  const seed = process.env.OMB_COMPANION_DIR ?? `${process.env.HOME ?? ""}/.openmausbot-companion`;
  return createHmac("sha256", "openmausbot-viewer-access").update(seed).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function mintViewerAccessToken(deviceId: string, botId: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  const nonce = randomBytes(8).toString("base64url");
  const payload = `${VERSION}.${deviceId}.${botId}.${exp}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyViewerAccessToken(token: string, botId: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== VERSION) return null;
  const [, deviceId, tokenBotId, expRaw, nonce, signature] = parts;
  if (!deviceId || tokenBotId !== botId || !nonce || !signature) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now) return null;
  const payload = parts.slice(0, 5).join(".");
  const expected = sign(payload);
  if (expected.length !== signature.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  } catch {
    return null;
  }
  return deviceId;
}

export function appendViewerAccessQuery(viewerPath: string, token: string): string {
  const hashIndex = viewerPath.indexOf("#");
  const base = hashIndex >= 0 ? viewerPath.slice(0, hashIndex) : viewerPath;
  const fragment = hashIndex >= 0 ? viewerPath.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}omb_viewer=${encodeURIComponent(token)}${fragment}`;
}

export const VIEWER_ACCESS_COOKIE = "omb_viewer";

export function viewerAccessCookiePath(botId: string): string {
  return `/api/bots/${botId}/local-computer/viewer`;
}

export function parseViewerAccessCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${VIEWER_ACCESS_COOKIE}=`)) continue;
    const value = trimmed.slice(VIEWER_ACCESS_COOKIE.length + 1);
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/** Resolve a paired device from the viewer ticket query param or cookie. */
export function resolveViewerAccessDeviceId(
  fullUrl: string,
  cookieHeader: string | undefined,
  botId: string,
  now = Date.now(),
): string | null {
  const ticket = new URL(fullUrl, "http://localhost").searchParams.get(VIEWER_ACCESS_COOKIE)
    ?? parseViewerAccessCookie(cookieHeader);
  if (!ticket) return null;
  return verifyViewerAccessToken(ticket, botId, now);
}

export function viewerAccessSetCookieHeader(token: string, botId: string): string {
  const maxAge = Math.floor(TTL_MS / 1000);
  return `${VIEWER_ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=${viewerAccessCookiePath(botId)}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict`;
}

export function stripViewerAccessQuery(url: string): string {
  const hashIndex = url.indexOf("#");
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex < 0) return url;
  const pathPart = withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  params.delete(VIEWER_ACCESS_COOKIE);
  const nextQuery = params.toString();
  return nextQuery ? `${pathPart}?${nextQuery}${hash}` : `${pathPart}${hash}`;
}

export function viewerAccessSetCookieForRequest(
  fullUrl: string,
  method: string,
  path: string,
  botId: string,
  status: number,
  now = Date.now(),
): string | null {
  if (method !== "GET" || status < 200 || status >= 300) return null;
  const ticket = new URL(fullUrl, "http://localhost").searchParams.get(VIEWER_ACCESS_COOKIE);
  if (!ticket || !path.startsWith(viewerAccessCookiePath(botId))) return null;
  if (!verifyViewerAccessToken(ticket, botId, now)) return null;
  return viewerAccessSetCookieHeader(ticket, botId);
}
