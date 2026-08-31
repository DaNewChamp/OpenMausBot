import type { ApprovalExplanationReviewer, ApprovalReviewInput } from "./approval-explainer.ts";
import {
  APPROVAL_REVIEW_SYSTEM,
  buildApprovalReviewPrompt,
  extractReviewedJson,
} from "./approval-reviewer.ts";

export interface ChatCompletionReviewRequest {
  url: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
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
  const prompt = buildApprovalReviewPrompt(input);
  const payload = chatCompletionReviewPayload(request.model, prompt);
  assertNoToolsInPayload(payload);
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeBaseUrl(request.url)}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${request.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new Error(`approval review HTTP ${response.status}`);
  const json: unknown = await response.json();
  const content = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content !== "string") return extractReviewedJson(JSON.stringify(json));
  return extractReviewedJson(content);
}

export function createDirectReviewer(request: ChatCompletionReviewRequest): ApprovalExplanationReviewer {
  return (input, signal) => reviewViaChatCompletions(request, input, signal);
}
