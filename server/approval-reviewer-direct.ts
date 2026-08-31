import type { ApprovalExplanationReviewer, ApprovalReviewInput } from "./approval-explainer.ts";
import {
  APPROVAL_REVIEW_SYSTEM,
  buildApprovalReviewPrompt,
  extractReviewedJson,
  isAllowedReviewerUrl,
} from "./approval-reviewer.ts";

export interface ChatCompletionReviewRequest {
  url: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

export const DEFAULT_REVIEW_RESPONSE_MAX_BYTES = 64 * 1024;

export function reviewEndpoint(url: string): URL {
  const raw = url.trim();
  if (!isAllowedReviewerUrl(raw)) {
    throw new Error("approval reviewer URL must use HTTPS, or loopback HTTP");
  }
  const base = new URL(raw);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/chat/completions`;
  return base;
}

export function chatCompletionReviewPayload(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    stream: false,
    messages: [
      { role: "system", content: APPROVAL_REVIEW_SYSTEM },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  };
}

export function assertNoToolsInPayload(payload: Record<string, unknown>): void {
  if ("tools" in payload || "functions" in payload || "tool_choice" in payload) {
    throw new Error("approval review payload must not include tools");
  }
}

export async function reviewViaChatCompletions(
  request: ChatCompletionReviewRequest,
  input: ApprovalReviewInput,
  signal: AbortSignal,
): Promise<unknown> {
  if (!request.apiKey || /[\r\n]/.test(request.apiKey)) throw new Error("approval reviewer API key is invalid");
  const prompt = buildApprovalReviewPrompt(input);
  const payload = chatCompletionReviewPayload(request.model, prompt);
  assertNoToolsInPayload(payload);
  const fetchImpl = request.fetchImpl ?? fetch;
  const endpoint = reviewEndpoint(request.url);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
    redirect: "error",
  });
  if (response.redirected || response.type === "opaqueredirect") {
    throw new Error("approval reviewer refused a redirect");
  }
  if (response.url) {
    const responseUrl = new URL(response.url);
    if (responseUrl.origin !== endpoint.origin) throw new Error("approval reviewer response changed origin");
  }
  if (!response.ok) throw new Error(`approval review HTTP ${response.status}`);
  const body = await readResponseTextCapped(response, request.maxResponseBytes ?? DEFAULT_REVIEW_RESPONSE_MAX_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("approval reviewer returned invalid JSON");
  }
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content !== "string") return extractReviewedJson(JSON.stringify(json));
  return extractReviewedJson(content);
}

export async function readResponseTextCapped(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("approval reviewer response cap is invalid");
  const declared = response.headers.get("content-length");
  if (declared && Number.isSafeInteger(Number(declared)) && Number(declared) > maxBytes) {
    throw new Error("approval reviewer response exceeded the byte limit");
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("approval reviewer response exceeded the byte limit");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("approval reviewer response exceeded the byte limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createDirectReviewer(request: ChatCompletionReviewRequest): ApprovalExplanationReviewer {
  return (input, signal) => reviewViaChatCompletions(request, input, signal);
}
