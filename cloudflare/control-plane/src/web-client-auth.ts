import type { ControlPlaneAuth } from "./auth";
import { consumeWebClientAuthExchange, createWebClientAuthExchange } from "./web-client-auth-exchanges";
import { errorResponse } from "./http";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const BETTER_AUTH_SESSION_COOKIE = "__Secure-better-auth.session_token";

export function allowedWebClientRedirect(
  value: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(value);
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return false;
    if (url.username || url.password) return false;
    return allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

export async function completeWebClientAuth(
  request: Request,
  auth: ControlPlaneAuth,
  allowedOrigins: ReadonlySet<string>,
  db: D1Database,
): Promise<Response> {
  const url = new URL(request.url);
  const redirect = url.searchParams.get("redirect");
  if (!redirect || !allowedWebClientRedirect(redirect, allowedOrigins)) {
    return errorResponse(400, "invalid_request");
  }
  const target = new URL(redirect);
  const session = await auth.api.getSession({ headers: request.headers });
  const accountToken = session?.session?.token;
  if (!accountToken || accountToken.length < 20) {
    target.searchParams.set("auth_error", "session");
    return Response.redirect(target.toString(), 302);
  }
  const exchange = await createWebClientAuthExchange(db, accountToken);
  target.searchParams.set("web_auth_code", exchange.code);
  return Response.redirect(target.toString(), 302);
}

export async function exchangeWebClientAuth(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
  db: D1Database,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.has(origin)) return errorResponse(403, "origin_not_allowed");
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "invalid_request");
  }
  const code = typeof payload === "object" && payload && "code" in payload
    ? String((payload as { code?: unknown }).code ?? "")
    : "";
  const accountToken = await consumeWebClientAuthExchange(db, code);
  if (!accountToken) return errorResponse(401, "unauthorized");
  return Response.json(
    { accountToken },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}
