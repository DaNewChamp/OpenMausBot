import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ChildProcessByStdio, SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { ApprovalExplanationReviewer, ApprovalReviewInput } from "./approval-explainer.ts";
import {
  APPROVAL_REVIEW_JSON_SCHEMA,
  APPROVAL_REVIEW_SYSTEM,
  buildApprovalReviewPrompt,
  extractReviewedJson,
} from "./approval-reviewer.ts";
import { readResponseTextCapped } from "./approval-reviewer-direct.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { minimalCliEnv } from "./approval-reviewer-cli.ts";

/** The first-party Codex subscription route. The OAuth token never leaves the
 * server and is only sent to this fixed OpenAI-owned origin. */
export const CODEX_REVIEW_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_REVIEW_ORIGINATOR = "codex_cli_rs";
export const DEFAULT_CODEX_REVIEW_RESPONSE_MAX_BYTES = 64 * 1024;
export const DEFAULT_CODEX_REFRESH_TIMEOUT_MS = 8_000;

export interface CodexOAuthCredentials {
  accessToken: string;
  accountId: string;
}

export interface CodexOAuthReviewRequest {
  model: string;
  /** Optional one-shot credentials for callers that already hold a token.
   * The bound reviewer intentionally omits these and re-reads auth.json for
   * every review so an expired token is never retained across turns. */
  accessToken?: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  cli?: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  endpoint?: string;
}

export type CodexAppServerSpawn = (
  cli: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessByStdio<Writable, Readable, Readable>;

export interface CodexOAuthRefreshOptions {
  env?: NodeJS.ProcessEnv;
  cli?: string;
  timeoutMs?: number;
  spawn?: CodexAppServerSpawn;
  /** Refresh even when the current access token has not expired. Used only
   * after the backend rejects a freshly-read token with HTTP 401. */
  force?: boolean;
}

type JsonRecord = Record<string, unknown>;

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\r\n\u0000]/.test(text)) return null;
  return text;
}

function codexHomePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured && isAbsolute(configured)) return configured;
  return join(homedir(), ".codex");
}

function decodeJwtPayload(token: string): JsonRecord | null {
  const pieces = token.split(".");
  if (pieces.length !== 3) return null;
  try {
    const payload = Buffer.from(pieces[1]!, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function tokenAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const auth = payload["https://api.openai.com/auth"];
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    return nonEmptyString((auth as JsonRecord).chatgpt_account_id, 256);
  }
  return nonEmptyString(payload.chatgpt_account_id, 256);
}

function tokenIsExpired(token: string, now = Date.now()): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp * 1_000 <= now;
}

function appServerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = minimalCliEnv(source);
  // CODEX_HOME is not inherited by minimalCliEnv because normal agent
  // processes should not receive arbitrary deployment variables. The
  // official app-server must nevertheless read the same login we just
  // inspected, so pass only this validated absolute path explicitly.
  env.CODEX_HOME = codexHomePath(source);
  return env;
}

const refreshInFlight = new Map<string, Promise<boolean>>();

function runCodexAppServerRefresh(options: CodexOAuthRefreshOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const cli = options.cli?.trim() || "codex";
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_REFRESH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
    let settled = false;
    let buffer = "";
    let initialized = false;
    let refreshRequested = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child) killCliTree(child);
      // The app-server persists refreshed auth before replying to account/read.
      // Re-read from disk rather than trusting any token-shaped protocol data.
      resolve(success && readCodexOAuthCredentialsSync(env) !== null);
    };
    const send = (message: Record<string, unknown>) => {
      try {
        child?.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(false);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      child = (options.spawn ?? spawnCli)(cli, ["app-server", "--listen", "stdio://"], {
        cwd: homedir(),
        env: appServerEnvironment(env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(false);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buffer += String(chunk);
      if (buffer.length > 32_768) {
        finish(false);
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          message = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = message.id;
        if (id === 1) {
          if (message.error) {
            finish(false);
            return;
          }
          initialized = true;
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/read", params: { refreshToken: true } });
          refreshRequested = true;
          continue;
        }
        if (id === 2 && initialized && refreshRequested) {
          finish(!message.error && message.result !== undefined);
          return;
        }
      }
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(false));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "openmausbot-approval-reviewer", version: "1" } },
    });
  });
}

/** Refresh through the official app-server `account/read` protocol. The
 * refresh token remains owned by Codex; this process never receives approval
 * text and never returns token material. Concurrent callers share one run. */
export async function refreshCodexOAuthCredentials(
  options: CodexOAuthRefreshOptions = {},
): Promise<CodexOAuthCredentials | null> {
  const env = options.env ?? process.env;
  if (!options.force) {
    const current = readCodexOAuthCredentialsSync(env);
    if (current) return current;
  }
  const lockKey = codexHomePath(env);
  let inFlight = refreshInFlight.get(lockKey);
  if (!inFlight) {
    inFlight = runCodexAppServerRefresh(options).finally(() => {
      refreshInFlight.delete(lockKey);
    });
    refreshInFlight.set(lockKey, inFlight);
  }
  const refreshed = await inFlight;
  return refreshed ? readCodexOAuthCredentialsSync(env) : null;
}

export async function freshCodexOAuthCredentials(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<CodexOAuthRefreshOptions, "env"> = {},
): Promise<CodexOAuthCredentials | null> {
  const current = readCodexOAuthCredentialsSync(env);
  if (current) return current;
  return refreshCodexOAuthCredentials({ ...options, env });
}

/**
 * Read only the short-lived access token and account id from the existing
 * Codex login. The refresh token and id token are intentionally ignored. A
 * symlink or group/world-readable auth file is rejected so an approval
 * reviewer cannot accidentally follow an attacker-controlled path.
 */
export function readCodexOAuthCredentialsSync(
  env: NodeJS.ProcessEnv = process.env,
): CodexOAuthCredentials | null {
  const authPath = join(codexHomePath(env), "auth.json");
  try {
    if (!existsSync(authPath) || lstatSync(authPath).isSymbolicLink()) return null;
    const stats = statSync(authPath);
    if (!stats.isFile() || stats.size > 1_048_576 || (stats.mode & 0o077) !== 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const auth = parsed as JsonRecord;
    const tokens = auth.tokens;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
    const tokenRecord = tokens as JsonRecord;
    const accessToken = nonEmptyString(tokenRecord.access_token, 16_384);
    const accountId = nonEmptyString(tokenRecord.account_id, 256) ??
      (accessToken ? tokenAccountId(accessToken) : null);
    if (!accessToken || !accountId || tokenIsExpired(accessToken)) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

export function codexOAuthIsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return readCodexOAuthCredentialsSync(env) !== null;
}

export function codexReviewPayload(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    instructions: APPROVAL_REVIEW_SYSTEM,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    }],
    // Explicitly request a text-only turn. No tools, MCP, computer, shell,
    // files, attachments, or working directory are present in this payload.
    tool_choice: "none",
    parallel_tool_calls: false,
    store: false,
    stream: false,
    include: [],
    text: {
      format: {
        type: "json_schema",
        strict: true,
        name: "approval_review",
        schema: APPROVAL_REVIEW_JSON_SCHEMA,
      },
    },
  };
}

export function assertCodexNoToolsPayload(payload: Record<string, unknown>): void {
  for (const key of [
    "tools", "functions", "computer", "mcp", "attachments", "files", "cwd", "shell", "container",
  ]) {
    if (key in payload) throw new Error(`Codex approval review payload must not include ${key}`);
  }
  if (payload.tool_choice !== "none" || payload.parallel_tool_calls !== false || payload.store !== false || payload.stream !== false) {
    throw new Error("Codex approval review payload must disable tools and persistence");
  }
}

function extractResponseText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (typeof record.output_text === "string") return record.output_text;
  const output = record.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as JsonRecord).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const text = (part as JsonRecord).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

export function extractCodexReviewedJson(body: unknown): unknown {
  const text = extractResponseText(body);
  return text ? extractReviewedJson(text) : extractReviewedJson(JSON.stringify(body));
}

function endpointUrl(raw: string): URL {
  const endpoint = new URL(raw);
  if (endpoint.origin !== "https://chatgpt.com" || endpoint.pathname !== "/backend-api/codex/responses" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error("Codex approval reviewer endpoint is not allowed");
  }
  return endpoint;
}

export async function reviewViaCodexOAuth(
  request: CodexOAuthReviewRequest,
  input: ApprovalReviewInput,
  signal: AbortSignal,
): Promise<unknown> {
  const accessToken = nonEmptyString(request.accessToken, 16_384);
  const accountId = nonEmptyString(request.accountId, 256);
  const model = nonEmptyString(request.model, 500);
  if (!accessToken || !accountId || !model || /[\r\n]/.test(request.model)) {
    throw new Error("Codex OAuth reviewer credentials or model are invalid");
  }
  if (tokenIsExpired(accessToken)) throw new Error("Codex OAuth reviewer access token is expired");
  const endpoint = endpointUrl(request.endpoint ?? CODEX_REVIEW_ENDPOINT);
  const prompt = buildApprovalReviewPrompt(input);
  const payload = codexReviewPayload(model, prompt);
  assertCodexNoToolsPayload(payload);
  const maxBytes = request.maxResponseBytes ?? DEFAULT_CODEX_REVIEW_RESPONSE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Codex approval reviewer response cap is invalid");
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      originator: CODEX_REVIEW_ORIGINATOR,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
    redirect: "error",
  });
  if (response.redirected || response.type === "opaqueredirect") throw new Error("Codex approval reviewer refused a redirect");
  if (response.url && new URL(response.url).origin !== endpoint.origin) throw new Error("Codex approval reviewer response changed origin");
  if (!response.ok) throw new Error(`Codex approval reviewer HTTP ${response.status}`);
  const body = await readResponseTextCapped(response, Math.min(maxBytes, DEFAULT_CODEX_REVIEW_RESPONSE_MAX_BYTES));
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Codex approval reviewer returned invalid JSON");
  }
  return extractCodexReviewedJson(json);
}

export function createCodexOAuthReviewer(request: CodexOAuthReviewRequest): ApprovalExplanationReviewer {
  return async (input, signal) => {
    // A caller that supplied explicit credentials is a one-shot operation.
    // Bound reviewers omit them and resolve the current auth.json immediately
    // before each review, so rotated access tokens are never cached.
    if (request.accessToken || request.accountId) {
      return reviewViaCodexOAuth(request, input, signal);
    }
    const env = request.env ?? process.env;
    const credentials = await freshCodexOAuthCredentials(env, { cli: request.cli });
    if (!credentials) throw new Error("Codex OAuth reviewer is unavailable; sign in again on this server");
    try {
      return await reviewViaCodexOAuth({
        ...request,
        accessToken: credentials.accessToken,
        accountId: credentials.accountId,
      }, input, signal);
    } catch (error) {
      // A token can be revoked between the disk read and the HTTP request.
      // Refresh once through Codex's official app-server path, then re-read
      // auth.json and retry. No approval text is passed to that process.
      if (!(error instanceof Error) || !/HTTP 401\b/.test(error.message)) throw error;
      const refreshed = await refreshCodexOAuthCredentials({ env, cli: request.cli, force: true });
      if (!refreshed) throw new Error("Codex OAuth reviewer access expired; sign in again on this server");
      return reviewViaCodexOAuth({
        ...request,
        accessToken: refreshed.accessToken,
        accountId: refreshed.accountId,
      }, input, signal);
    }
  };
}
