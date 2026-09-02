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
  it("creates and consumes a one-time exchange code", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            statements.push({ sql, args });
            return {
              run: async () => ({}),
              first: async () =>
                sql.includes("SELECT")
                  ? {
                      accountToken: "signed." + "a".repeat(40),
                      expiresAt: Date.now() + 60_000,
                      consumedAt: null,
                    }
                  : null,
            };
          },
        };
      },
    } as unknown as D1Database;

    const created = await createWebClientAuthExchange(db, "signed." + "a".repeat(40));
    expect(created.code.length).toBeGreaterThan(30);
    const token = await consumeWebClientAuthExchange(db, created.code);
    expect(token?.startsWith("signed.")).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("INSERT"))).toBe(true);
    expect(statements.some((entry) => entry.sql.includes("UPDATE"))).toBe(true);
  });
});
