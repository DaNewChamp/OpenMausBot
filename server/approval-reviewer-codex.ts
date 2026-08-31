import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { ApprovalExplanationReviewer, ApprovalReviewInput } from "./approval-explainer.ts";
import {
  APPROVAL_REVIEW_JSON_SCHEMA,
  APPROVAL_REVIEW_SYSTEM,
  buildApprovalReviewPrompt,
  extractReviewedJson,
} from "./approval-reviewer.ts";
import { readResponseTextCapped } from "./approval-reviewer-direct.ts";

/** The first-party Codex subscription route. The OAuth token never leaves the
 * server and is only sent to this fixed OpenAI-owned origin. */
export const CODEX_REVIEW_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_REVIEW_ORIGINATOR = "codex_cli_rs";
export const DEFAULT_CODEX_REVIEW_RESPONSE_MAX_BYTES = 64 * 1024;

export interface CodexOAuthCredentials {
  accessToken: string;
  accountId: string;
}

export interface CodexOAuthReviewRequest {
  model: string;
  accessToken: string;
  accountId: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  endpoint?: string;
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
  return (input, signal) => reviewViaCodexOAuth(request, input, signal);
}
