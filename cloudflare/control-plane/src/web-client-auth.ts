import type { ControlPlaneAuth } from "./auth";
import { errorResponse } from "./http";

const SESSION_COOKIE_MARKER = "session_token";
const INSTALLATION_CREDENTIAL_PREFIX = "omb_install_";

export function allowedWebClientRedirect(
  value: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function sessionBearerFromCookies(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name.includes(SESSION_COOKIE_MARKER)) continue;
    const value = decodeURIComponent(part.slice(index + 1).trim());
    if (value.length < 20 || value.startsWith(INSTALLATION_CREDENTIAL_PREFIX)) return null;
    return value;
  }
  return null;
}

export async function completeWebClientAuth(
  request: Request,
  auth: ControlPlaneAuth,
  allowedOrigins: ReadonlySet<string>,
): Promise<Response> {
  const url = new URL(request.url);
  const redirect = url.searchParams.get("redirect");
  if (!redirect || !allowedWebClientRedirect(redirect, allowedOrigins)) {
    return errorResponse(400, "invalid_request");
  }
  const target = new URL(redirect);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    target.searchParams.set("auth_error", "session");
    return Response.redirect(target.toString(), 302);
  }
  const token = sessionBearerFromCookies(request.headers.get("cookie"));
  if (!token) {
    target.searchParams.set("auth_error", "session");
    return Response.redirect(target.toString(), 302);
  }
  target.hash = `account=${encodeURIComponent(token)}`;
  return Response.redirect(target.toString(), 302);
}
