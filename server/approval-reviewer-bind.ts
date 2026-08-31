import type { AppConfig } from "./config.ts";
import type { ApprovalExplanationReviewer } from "./approval-explainer.ts";
import {
  buildApprovalReviewerStatus,
  catalogContainsSecrets,
  DEFAULT_OPENAI_COMPAT_URL,
  DEFAULT_XAI_URL,
  XAI_REVIEW_INSTANCE_ID,
  findReviewerProvider,
  isAllowedReviewerUrl,
  reviewDriverFamily,
  reviewerCacheIdentity,
  type ApprovalReviewerProvider,
  type ApprovalReviewerSelection,
  type ApprovalReviewerStatus,
  type BoundApprovalReviewer,
  type DirectReviewCredentials,
  type ReviewerCatalogInstance,
} from "./approval-reviewer.ts";
import { createDirectReviewer } from "./approval-reviewer-direct.ts";
import { createCodexOAuthReviewer, freshCodexOAuthCredentials } from "./approval-reviewer-codex.ts";
import { createCliReviewer, probeReviewerHints, validateReviewerCli, type IsolatedCliRunner } from "./approval-reviewer-cli.ts";

export function credentialsFromConfig(cfg: AppConfig): DirectReviewCredentials {
  return {
    openaiCompat: { key: cfg.openaiCompat?.key, url: cfg.openaiCompat?.url },
    xai: { key: cfg.xai?.key, url: cfg.xai?.url },
  };
}

function directUrl(family: "openai-compat" | "xai", credentials: DirectReviewCredentials): string | null {
  if (family === "openai-compat") {
    const url = credentials.openaiCompat?.url?.trim();
    return url || DEFAULT_OPENAI_COMPAT_URL;
  }
  const url = credentials.xai?.url?.trim();
  return url || DEFAULT_XAI_URL;
}

function directKey(family: "openai-compat" | "xai", credentials: DirectReviewCredentials): string {
  return family === "openai-compat"
    ? (credentials.openaiCompat?.key ?? "")
    : (credentials.xai?.key ?? "");
}

export async function liveApprovalReviewerStatus(
  cfg: AppConfig,
  instances: readonly ReviewerCatalogInstance[],
  runCli?: IsolatedCliRunner,
): Promise<ApprovalReviewerStatus> {
  const credentials = credentialsFromConfig(cfg);
  const hints = {
    ...(await probeReviewerHints(instances, runCli)),
    codexOAuthAvailable: (await freshCodexOAuthCredentials()) !== null,
  };
  const status = buildApprovalReviewerStatus(cfg, instances, credentials, hints);
  if (catalogContainsSecrets(status)) {
    throw new Error("approval reviewer status failed redaction");
  }
  return status;
}

export function bindApprovalReviewer(input: {
  selection: ApprovalReviewerSelection;
  providers: readonly ApprovalReviewerProvider[];
  instances: readonly ReviewerCatalogInstance[];
  credentials: DirectReviewCredentials;
  fetchImpl?: typeof fetch;
  runCli?: IsolatedCliRunner;
  env?: NodeJS.ProcessEnv;
}): BoundApprovalReviewer | null {
  if (!input.selection.instanceId || !input.selection.model) return null;
  const provider = findReviewerProvider(input.providers, input.selection.instanceId, input.selection.model);
  if (!provider?.available) return null;
  const instance = input.instances.find((row) => row.instanceId === input.selection.instanceId);
  const family = reviewDriverFamily(
    instance?.driverKind || (input.selection.instanceId === XAI_REVIEW_INSTANCE_ID ? "grok" : ""),
    input.selection.instanceId,
  );
  const identity = reviewerCacheIdentity(input.selection.instanceId, input.selection.model);
  if (family === "openai-compat" || family === "xai") {
    const key = directKey(family, input.credentials);
    const url = directUrl(family, input.credentials);
    if (!key || !url || !isAllowedReviewerUrl(url)) return null;
    const review: ApprovalExplanationReviewer = createDirectReviewer({
      url,
      apiKey: key,
      model: input.selection.model,
      fetchImpl: input.fetchImpl,
    });
    return { identity, review };
  }
  if (family === "codex") {
    // Do not capture an access token here. The reviewer resolves and
    // re-reads Codex auth immediately before each review, including a safe
    // app-server refresh when the short-lived token has expired.
    return {
      identity,
      review: createCodexOAuthReviewer({
        model: input.selection.model,
        fetchImpl: input.fetchImpl,
        env: input.env,
      }),
    };
  }
  if (family === "claude") {
    const cli = instance?.cli?.trim() || instance?.cliDefault?.trim();
    if (!cli || !validateReviewerCli(cli)) return null;
    return {
      identity,
      review: createCliReviewer({
        cli,
        family,
        model: input.selection.model,
        run: input.runCli,
        env: input.env,
      }),
    };
  }
  return null;
}
