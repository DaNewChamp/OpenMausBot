import { randomBytes } from "node:crypto";

const EXCHANGE_TTL_MS = 120_000;

export interface WebClientAuthExchange {
  code: string;
  accountToken: string;
  expiresAt: number;
}

export async function createWebClientAuthExchange(
  db: D1Database,
  accountToken: string,
  now = Date.now(),
): Promise<WebClientAuthExchange> {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = now + EXCHANGE_TTL_MS;
  await db
    .prepare(
      "INSERT INTO web_client_auth_exchanges (code, account_token, expires_at) VALUES (?1, ?2, ?3)",
    )
    .bind(code, accountToken, expiresAt)
    .run();
  return { code, accountToken, expiresAt };
}

export async function consumeWebClientAuthExchange(
  db: D1Database,
  code: string,
  now = Date.now(),
): Promise<string | null> {
  const normalized = String(code ?? "").trim();
  if (normalized.length < 32 || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return null;
  }
  const row = await db
    .prepare(
      "SELECT account_token AS accountToken, expires_at AS expiresAt, consumed_at AS consumedAt " +
        "FROM web_client_auth_exchanges WHERE code = ?1",
    )
    .bind(normalized)
    .first<{ accountToken: string; expiresAt: number; consumedAt: number | null }>();
  if (!row || row.consumedAt !== null || row.expiresAt <= now) return null;
  await db
    .prepare("UPDATE web_client_auth_exchanges SET consumed_at = ?1 WHERE code = ?2 AND consumed_at IS NULL")
    .bind(now, normalized)
    .run();
  return row.accountToken.length >= 20 ? row.accountToken : null;
}
