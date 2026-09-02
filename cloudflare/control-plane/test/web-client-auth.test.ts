import { describe, expect, it } from "vitest";

import {
  allowedWebClientRedirect,
  BETTER_AUTH_SESSION_COOKIE,
} from "../src/web-client-auth";
import {
  consumeWebClientAuthExchange,
  createWebClientAuthExchange,
} from "../src/web-client-auth-exchanges";

describe("web client auth completion", () => {
  const allowed = new Set(["https://app.openmausbot.com", "https://accounts.openmausbot.com"]);

  it("accepts only exact allowed origins without credentials in the URL", () => {
    expect(allowedWebClientRedirect("https://app.openmausbot.com/?client=web", allowed)).toBe(true);
    expect(allowedWebClientRedirect("http://127.0.0.1:5199/?client=web", allowed)).toBe(false);
    expect(allowedWebClientRedirect("https://evil.example/?client=web", allowed)).toBe(false);
    expect(allowedWebClientRedirect("https://user:pass@app.openmausbot.com/", allowed)).toBe(false);
  });

  it("uses the exact Better Auth session cookie name", () => {
    expect(BETTER_AUTH_SESSION_COOKIE).toBe("__Secure-better-auth.session_token");
  });
});

describe("web client auth exchanges", () => {
  function exchangeDb() {
    let consumed = false;
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            statements.push({ sql, args });
            return {
              run: async () => ({ meta: { changes: consumed ? 0 : 1 } }),
              first: async () => {
                if (sql.includes("UPDATE") && sql.includes("RETURNING")) {
                  if (consumed) return null;
                  consumed = true;
                  return { accountToken: "signed." + "a".repeat(40) };
                }
                return null;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    return { db, statements };
  }

  it("creates and consumes a one-time exchange code", async () => {
    const { db, statements } = exchangeDb();
    const created = await createWebClientAuthExchange(db, "signed." + "a".repeat(40));
    expect(created.code.length).toBeGreaterThan(30);
    const token = await consumeWebClientAuthExchange(db, created.code);
    expect(token?.startsWith("signed.")).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("INSERT"))).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("UPDATE") && entry.sql.includes("RETURNING"))).toBe(true);
  });

  it("allows exactly one concurrent exchange consume", async () => {
    const { db } = exchangeDb();
    const created = await createWebClientAuthExchange(db, "signed." + "a".repeat(40));
    const results = await Promise.all([
      consumeWebClientAuthExchange(db, created.code),
      consumeWebClientAuthExchange(db, created.code),
    ]);
    const successes = results.filter((token) => token !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]?.startsWith("signed.")).toBe(true);
  });
});

describe("web client auth handoff", () => {
  const allowed = new Set(["https://app.openmausbot.com"]);

  it("embeds a postMessage handoff without putting the code in a redirect URL", async () => {
    const { renderWebClientAuthHandoff } = await import("../src/web-client-auth");
    const response = renderWebClientAuthHandoff(
      "a".repeat(43),
      "https://app.openmausbot.com/?client=web",
      allowed,
    );
    const html = await response.text();
    expect(html).toContain("omb_web_auth_code");
    expect(html).toContain("postMessage");
    expect(html).not.toContain("web_auth_code=");
    expect(html).toContain("https://app.openmausbot.com");
  });

  it("rejects handoff for disallowed redirect origins", async () => {
    const { renderWebClientAuthHandoff } = await import("../src/web-client-auth");
    const response = renderWebClientAuthHandoff(
      "a".repeat(43),
      "https://evil.example/?client=web",
      allowed,
    );
    expect(response.status).toBe(400);
  });
});
