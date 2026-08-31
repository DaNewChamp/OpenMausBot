// Global approval-reviewer setting and catalog.
//
// This is display-only: a selected model may rewrite purpose/change/where/risk
// text. It cannot approve, deny, or lower the deterministic risk. Credentials
// stay on the server; clients see mode, selection, models, and availability.

import { classifyProvider, NAMED_PROVIDER_LABELS, providerLabel } from "./provider-catalog.ts";
import type { ApprovalExplanation, ApprovalExplanationReviewer, ApprovalReviewInput } from "./approval-explainer.ts";

export const APPROVAL_REVIEWER_MODES = ["off", "when-unclear", "always"] as const;
export type ApprovalReviewerMode = (typeof APPROVAL_REVIEWER_MODES)[number];
export const DEFAULT_APPROVAL_REVIEWER_MODE: ApprovalReviewerMode = "when-unclear";

export const APPROVAL_REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    purpose: { type: "string" },
    change: { type: "string" },
    where: { type: "string" },
    risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["purpose", "change", "where", "risk"],
} as const;

export const APPROVAL_REVIEW_SYSTEM =
  "Rewrite the approval request as JSON with keys purpose, change, where, and risk. risk must be low, medium, or high. You cannot approve or deny. Do not lower risk below localRisk. Name files and resources explicitly. Return JSON only.";

export type ReviewDriverFamily =
  | "openai-compat"
  | "xai"
  | "claude"
  | "cursor"
  | "codex"
  | "grok-auth"
  | "other";

export type ReviewLaneKind = "direct" | "cli" | "unavailable";

export interface ApprovalReviewerSelection {
  mode: ApprovalReviewerMode;
  instanceId?: string;
  model?: string;
}

export interface ApprovalReviewerModel {
  id: string;
  label: string;
}

export interface ApprovalReviewerProvider {
  id: string;
  label: string;
  instanceId: string;
  available: boolean;
  configured: boolean;
  reason: string | null;
  models: ApprovalReviewerModel[];
}

export interface ApprovalReviewerStatus {
  mode: ApprovalReviewerMode;
  selection: { instanceId: string; model: string } | null;
  providers: ApprovalReviewerProvider[];
}

export interface ReviewerCatalogInstance {
  instanceId?: string;
  driverKind?: string;
  displayName?: string;
  snapshot?: {
    state?: string;
    reason?: string | null;
    authenticated?: boolean | null;
  };
  models?: {
    default?: string;
    options?: Array<{ id?: string; label?: string }>;
  };
  cli?: string;
  cliDefault?: string;
}

export interface DirectReviewCredentials {
  openaiCompat?: { key?: string; url?: string };
  xai?: { key?: string; url?: string };
}

const XAI_MODELS: ApprovalReviewerModel[] = [
  { id: "grok-4", label: "Grok 4" },
  { id: "grok-4-fast", label: "Grok 4 Fast" },
  { id: "grok-3-mini", label: "Grok 3 Mini" },
];

export const XAI_REVIEW_INSTANCE_ID = "xai-api";
export const DEFAULT_XAI_URL = "https://api.x.ai/v1";
export const DEFAULT_OPENAI_COMPAT_URL = "https://openrouter.ai/api/v1";

function compact(value: string | undefined): string {
  return (value ?? "").trim();
}

export function isApprovalReviewerMode(value: unknown): value is ApprovalReviewerMode {
  return typeof value === "string" && (APPROVAL_REVIEWER_MODES as readonly string[]).includes(value);
}

export function approvalReviewerSelection(cfg: {
  approvalReviewer?: { mode?: ApprovalReviewerMode; instanceId?: string; model?: string };
}): ApprovalReviewerSelection {
  const mode = isApprovalReviewerMode(cfg.approvalReviewer?.mode)
    ? cfg.approvalReviewer.mode
    : DEFAULT_APPROVAL_REVIEWER_MODE;
  const instanceId = compact(cfg.approvalReviewer?.instanceId);
  const model = compact(cfg.approvalReviewer?.model);
  return {
    mode,
    ...(instanceId ? { instanceId } : {}),
    ...(model ? { model } : {}),
  };
}

export function shouldReviewApproval(
  mode: ApprovalReviewerMode,
  explanation: Pick<ApprovalExplanation, "confidence">,
): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return explanation.confidence === "low";
}

export function reviewDriverFamily(driverKind: string, instanceId: string): ReviewDriverFamily {
  const token = `${driverKind} ${instanceId}`.toLowerCase().replace(/_/g, "-");
  if (token.includes("openai-compat") || token.includes("openaicompat") || token.includes("openrouter")) {
    return "openai-compat";
  }
  if (/\bgrokagent\b/.test(token) || /grok-?agent/.test(token) || token.includes("grok-auth")) {
    return "grok-auth";
  }
  if (/\bgrok\b/.test(token) && !token.includes("reconstructed")) return "xai";
  if (token.includes("claude")) return "claude";
  if (token.includes("cursor")) return "cursor";
  if (/\bcodex\b/.test(token)) return "codex";
  return "other";
}

export function claudeHelpSupportsIsolatedReview(helpText: string): boolean {
  const help = helpText.toLowerCase().replace(/\s+/g, " ");
  return help.includes("--tools") && help.includes("disable all tools") && (help.includes("--print") || help.includes("-p"));
}

export function cursorHelpSupportsIsolatedReview(helpText: string): boolean {
  const help = helpText.toLowerCase();
  return help.includes("--mode") && help.includes("ask") && help.includes("read-only") &&
    help.includes("--print") && help.includes("--sandbox") && help.includes("enabled");
}

export function codexHelpSupportsIsolatedReview(helpText: string): boolean {
  const help = helpText.toLowerCase();
  return help.includes("exec") && help.includes("--sandbox") && help.includes("read-only") &&
    help.includes("--ephemeral") && help.includes("--ignore-user-config") &&
    help.includes("--skip-git-repo-check") && help.includes("--json");
}

export function detectCliReviewCapability(
  family: ReviewDriverFamily,
  helpText: string,
): { kind: "supported" } | { kind: "unavailable"; reason: string } {
  if (family === "claude") {
    if (claudeHelpSupportsIsolatedReview(helpText)) return { kind: "supported" };
    return {
      kind: "unavailable",
      reason: "Claude CLI does not advertise a no-tools print mode.",
    };
  }
  if (family === "cursor") {
    if (cursorHelpSupportsIsolatedReview(helpText)) return { kind: "supported" };
    return {
      kind: "unavailable",
      reason: "Cursor CLI does not advertise a read-only ask mode.",
    };
  }
  if (family === "codex") {
    if (codexHelpSupportsIsolatedReview(helpText)) return { kind: "supported" };
    return {
      kind: "unavailable",
      reason: "Codex CLI does not advertise an ephemeral read-only JSON mode.",
    };
  }
  if (family === "grok-auth") {
    return {
      kind: "unavailable",
      reason: "Grok CLI does not expose a proven no-tools review mode that also disables MCP.",
    };
  }
  return {
    kind: "unavailable",
    reason: "This engine has no isolated approval-review mode.",
  };
}

export function reviewLaneForFamily(family: ReviewDriverFamily): ReviewLaneKind {
  if (family === "openai-compat" || family === "xai") return "direct";
  if (family === "claude" || family === "cursor" || family === "codex") return "cli";
  return "unavailable";
}

export function buildApprovalReviewPrompt(input: ApprovalReviewInput): string {
  return [
    `tool: ${input.tool}`,
    `command: ${input.command}`,
    `host: ${input.host}`,
    `localPurpose: ${input.deterministic.executiveSummary}`,
    `localChange: ${input.deterministic.changeSummary}`,
    `localWhere: ${input.deterministic.resourceSummary}`,
    `localRisk: ${input.deterministic.riskLevel}`,
    "Return JSON: {\"purpose\":\"...\",\"change\":\"...\",\"where\":\"...\",\"risk\":\"low|medium|high\"}.",
  ].join("\n");
}

export function extractReviewedJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const start = candidate.search(/{/);
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function providerIdFor(instance: ReviewerCatalogInstance, family: ReviewDriverFamily, modelId: string): string {
  if (family === "xai") return "xai";
  if (family === "openai-compat") return "openrouter";
  return classifyProvider({
    instanceId: compact(instance.instanceId),
    driverKind: compact(instance.driverKind),
    modelId,
  });
}

function modelsOf(instance: ReviewerCatalogInstance): ApprovalReviewerModel[] {
  const seen = new Set<string>();
  const models: ApprovalReviewerModel[] = [];
  for (const option of instance.models?.options ?? []) {
    const id = compact(option.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: compact(option.label) || id });
  }
  return models;
}

function instanceConfigured(instance: ReviewerCatalogInstance, family: ReviewDriverFamily, credentials: DirectReviewCredentials): boolean {
  if (family === "openai-compat") return Boolean(compact(credentials.openaiCompat?.key));
  if (family === "xai") return Boolean(compact(credentials.xai?.key));
  if (family === "claude" || family === "cursor" || family === "codex") {
    return instance.snapshot?.authenticated === true;
  }
  if (instance.snapshot?.authenticated === true) return true;
  return instance.snapshot?.state === "available";
}

export function unavailableReasonFor(
  family: ReviewDriverFamily,
  input: {
    configured: boolean;
    helpText?: string;
    installed?: boolean;
  },
): string | null {
  if (family === "other") return "This engine cannot power approval summaries.";
  if (family === "openai-compat" && !input.configured) return "No OpenAI-compatible API key is configured.";
  if (family === "xai" && !input.configured) return "No xAI API key is configured.";
  if (reviewLaneForFamily(family) === "unavailable") {
    const capability = detectCliReviewCapability(family, input.helpText ?? "");
    return capability.kind === "unavailable" ? capability.reason : "This engine has no isolated approval-review mode.";
  }
  if (reviewLaneForFamily(family) === "cli") {
    if (input.installed === false) return "This CLI is not installed.";
    if (!input.configured) return "This CLI is not signed in.";
    const capability = detectCliReviewCapability(family, input.helpText ?? "");
    if (capability.kind === "unavailable") return capability.reason;
  }
  return null;
}

export interface ReviewerCapabilityHints {
  helpTextByCli?: Record<string, string>;
  installedByCli?: Record<string, boolean>;
}

export function buildApprovalReviewerCatalog(
  instances: readonly ReviewerCatalogInstance[],
  credentials: DirectReviewCredentials,
  hints: ReviewerCapabilityHints = {},
): ApprovalReviewerProvider[] {
  const providers: ApprovalReviewerProvider[] = [];
  const seenInstances = new Set<string>();
  let sawXaiInstance = false;

  for (const instance of instances) {
    const instanceId = compact(instance.instanceId);
    if (!instanceId || seenInstances.has(instanceId)) continue;
    const driverKind = compact(instance.driverKind) || instanceId;
    const family = reviewDriverFamily(driverKind, instanceId);
    if (family === "other") continue;
    seenInstances.add(instanceId);
    if (family === "xai") sawXaiInstance = true;
    const models = modelsOf(instance);
    if (!models.length && family !== "xai") continue;
    const cliName = compact(instance.cli) || compact(instance.cliDefault);
    const configured = instanceConfigured(instance, family, credentials);
    const reason = unavailableReasonFor(family, {
      configured,
      helpText: cliName ? hints.helpTextByCli?.[cliName] : undefined,
      installed: cliName ? hints.installedByCli?.[cliName] : undefined,
    });
    const firstModel = models[0]?.id ?? compact(instance.models?.default);
    const providerId = providerIdFor(instance, family, firstModel);
    providers.push({
      id: providerId,
      label: family === "xai"
        ? "Grok (API)"
        : family === "openai-compat"
          ? NAMED_PROVIDER_LABELS.openrouter
          : providerLabel(providerId, compact(instance.displayName), driverKind),
      instanceId,
      available: reason === null,
      configured,
      reason,
      models: models.length ? models : family === "xai" ? XAI_MODELS : [],
    });
  }

  if (!sawXaiInstance) {
    const configured = Boolean(compact(credentials.xai?.key));
    const reason = unavailableReasonFor("xai", { configured });
    providers.push({
      id: "xai",
      label: "Grok (API)",
      instanceId: XAI_REVIEW_INSTANCE_ID,
      available: reason === null,
      configured,
      reason,
      models: XAI_MODELS,
    });
  }

  return providers;
}

export function findReviewerProvider(
  providers: readonly ApprovalReviewerProvider[],
  instanceId: string,
  model: string,
): ApprovalReviewerProvider | undefined {
  return providers.find((provider) =>
    provider.instanceId === instanceId && provider.models.some((entry) => entry.id === model),
  );
}

export function sanitizeApprovalReviewerStatus(status: ApprovalReviewerStatus): ApprovalReviewerStatus {
  return {
    mode: status.mode,
    selection: status.selection,
    providers: status.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      instanceId: provider.instanceId,
      available: provider.available,
      configured: provider.configured,
      reason: provider.reason,
      models: provider.models.map((model) => ({ id: model.id, label: model.label })),
    })),
  };
}

export function catalogContainsSecrets(status: ApprovalReviewerStatus): boolean {
  return /"(?:api[_-]?key|cli|cliDefault|cliCandidates|install|environment|config|key|gatewayToken|token|secret|password|url)"/i
    .test(JSON.stringify(status));
}

export type ApprovalReviewerPatchResult =
  | { ok: true; patch: ApprovalReviewerSelection }
  | { ok: false; error: string };

export function parseApprovalReviewerPatch(body: unknown): ApprovalReviewerPatchResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "approval reviewer requires a JSON object" };
  }
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  const allowed = new Set(["mode", "instanceId", "model"]);
  const extra = keys.find((key) => !allowed.has(key));
  if (extra) return { ok: false, error: `unsupported approval reviewer field: ${extra}` };
  if (!isApprovalReviewerMode(values.mode)) {
    return { ok: false, error: "mode must be off, when-unclear, or always" };
  }
  const instanceId = values.instanceId === undefined ? undefined : values.instanceId;
  const model = values.model === undefined ? undefined : values.model;
  if (instanceId !== undefined && (typeof instanceId !== "string" || instanceId.length < 1 || instanceId.length > 200)) {
    return { ok: false, error: "instanceId must be a string" };
  }
  if (model !== undefined && (typeof model !== "string" || model.length < 1 || model.length > 500)) {
    return { ok: false, error: "model must be a string" };
  }
  if ((instanceId && !model) || (!instanceId && model)) {
    return { ok: false, error: "instanceId and model must be set together" };
  }
  return {
    ok: true,
    patch: {
      mode: values.mode,
      ...(instanceId ? { instanceId } : {}),
      ...(model ? { model } : {}),
    },
  };
}

export function validateReviewerSelection(
  patch: ApprovalReviewerSelection,
  providers: readonly ApprovalReviewerProvider[],
): { ok: true } | { ok: false; error: string } {
  if (!patch.instanceId && !patch.model) return { ok: true };
  const provider = findReviewerProvider(providers, patch.instanceId ?? "", patch.model ?? "");
  if (!provider) return { ok: false, error: "selected model is not in the approval reviewer catalog" };
  if (!provider.available) {
    return { ok: false, error: provider.reason || "selected reviewer is unavailable" };
  }
  return { ok: true };
}

export function resolveStoredSelection(
  selection: ApprovalReviewerSelection,
  providers: readonly ApprovalReviewerProvider[],
): { instanceId: string; model: string } | null {
  if (!selection.instanceId || !selection.model) {
    const fallback = providers.find((provider) => provider.available && provider.models.length > 0);
    const model = fallback?.models[0]?.id;
    return fallback && model ? { instanceId: fallback.instanceId, model } : null;
  }
  const provider = findReviewerProvider(providers, selection.instanceId, selection.model);
  if (!provider) return { instanceId: selection.instanceId, model: selection.model };
  return { instanceId: selection.instanceId, model: selection.model };
}

export function buildApprovalReviewerStatus(
  cfg: { approvalReviewer?: { mode?: ApprovalReviewerMode; instanceId?: string; model?: string } },
  instances: readonly ReviewerCatalogInstance[],
  credentials: DirectReviewCredentials,
  hints: ReviewerCapabilityHints = {},
): ApprovalReviewerStatus {
  const selection = approvalReviewerSelection(cfg);
  const providers = buildApprovalReviewerCatalog(instances, credentials, hints);
  return sanitizeApprovalReviewerStatus({
    mode: selection.mode,
    selection: resolveStoredSelection(selection, providers),
    providers,
  });
}

export function reviewerCacheIdentity(instanceId: string, model: string): string {
  return `${instanceId}:${model}`;
}

export type BoundApprovalReviewer = {
  identity: string;
  review: ApprovalExplanationReviewer;
};
