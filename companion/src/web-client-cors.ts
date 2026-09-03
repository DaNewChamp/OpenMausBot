import { denyReason, isBridgeDaemonRoute, isPublicWebPairingRoute, isWebPairingApproveRoute } from "./routes.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseWebClientOrigins(value: string | undefined): ReadonlySet<string> {
  if (!value?.trim()) return new Set();
  const origins = new Set<string>();
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      const loopback = LOOPBACK_HOSTS.has(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) continue;
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) continue;
      origins.add(url.origin);
    } catch {
      /* ignore malformed entries */
    }
  }
  return origins;
}

export function isBrowserSafeCompanionRoute(
  method: string,
  path: string,
  authenticated: boolean,
): boolean {
  if (isBridgeDaemonRoute(method, path)) return false;
  if (method === "POST" && path === "/api/pairing-invitations") return false;
  if (isWebPairingApproveRoute(method, path)) return false;
  if (method === "POST" && path === "/api/pair") return true;
  if (isPublicWebPairingRoute(method, path)) return true;
  if (!authenticated) return false;
  return denyReason({ path, method, authenticated }) === null;
}

const ALLOWED_PREFLIGHT_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
const ALLOWED_PREFLIGHT_HEADERS = new Set(["authorization", "content-type", "accept", "last-event-id"]);

export function webClientPreflightHeaders(
  origin: string,
  requestMethod: string | null,
  requestHeaders: string | null,
): Record<string, string> | null {
  const method = requestMethod?.toUpperCase() ?? "";
  if (!ALLOWED_PREFLIGHT_METHODS.has(method)) return null;
  const headers = (requestHeaders ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (headers.some((name) => !ALLOWED_PREFLIGHT_HEADERS.has(name))) return null;
  // The browser only fires the actual request when every header it asked
  // about is echoed back here — validating the list is not enough.
  return {
    ...corsResponseHeaders(origin),
    ...(headers.length ? { "access-control-allow-headers": headers.join(", ") } : {}),
  };
}

export function corsResponseHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}
