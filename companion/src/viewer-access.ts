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
