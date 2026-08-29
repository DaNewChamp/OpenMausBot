import { z } from "zod";

import { isEffortLevel, EFFORT_LEVELS, type EffortLevel, type ModelSelection } from "./contracts.ts";

const modelPatchSchema = z
  .object({
    instanceId: z
      .string({ error: "instanceId must be a string" })
      .min(1, { error: "instanceId must not be empty" })
      .max(200, { error: "instanceId must be at most 200 characters" }),
    model: z
      .string({ error: "model must be a string" })
      .min(1, { error: "model must not be empty" })
      .max(500, { error: "model must be at most 500 characters" }),
    effort: z.union([z.enum(EFFORT_LEVELS), z.null()]).optional(),
  })
  .strict();

export type BotModelPatch = { instanceId: string; model: string; effort?: EffortLevel | null };

export type BotModelPatchResult = { ok: true; patch: BotModelPatch } | { ok: false; error: string };

/** Advertised picker rows from `GET /api/instances` / `registry.describe()`. */
export interface AdvertisedInstanceCatalog {
  instanceId: string;
  models?: { default?: string; options?: Array<{ id?: string }> };
  capabilities?: { effortLevels?: readonly string[] };
}

export type BotModelSelectionResult =
  | { ok: true; selection: ModelSelection }
  | { ok: false; error: string };

/**
 * Resolve and commit a paired model switch against the bot state that still
 * exists after the (potentially slow) catalog refresh. The callbacks keep the
 * store dependency out of this module and make the await/re-check boundary
 * deterministic in tests.
 */
export async function guardedBotModelSwitch<Bot extends {
  id: string;
  busy?: boolean;
  modelSelection: ModelSelection;
}>(input: {
  requested: BotModelPatch;
  describe: () => Promise<readonly AdvertisedInstanceCatalog[]>;
  current: () => Bot | null;
  patch: (id: string, selection: ModelSelection) => Bot | null;
  queue?: (id: string, selection: ModelSelection) => Bot | null;
}): Promise<
  | { kind: "missing" }
  | { kind: "noop"; bot: Bot }
  | { kind: "busy" }
  | { kind: "queued"; bot: Bot }
  | { kind: "invalid"; error: string }
  | { kind: "patched"; bot: Bot }
 > {
  const catalogs = await input.describe();
  const current = input.current();
  if (!current) return { kind: "missing" };

  if (
    current.modelSelection.instanceId === input.requested.instanceId &&
    current.modelSelection.model === input.requested.model &&
    (input.requested.effort === undefined
      || (input.requested.effort === null && current.modelSelection.effort === undefined)
      || input.requested.effort === current.modelSelection.effort)
  ) {
    return { kind: "noop", bot: current };
  }
  if (current.busy) {
    const resolved = resolveBotModelSelection({
      instanceId: input.requested.instanceId,
      model: input.requested.model,
      currentEffort: current.modelSelection.effort,
      requestedEffort: input.requested.effort,
      catalogs,
    });
    if (!resolved.ok) return { kind: "invalid", error: resolved.error };
    const queued = input.queue?.(current.id, resolved.selection) ?? null;
    if (queued) return { kind: "queued", bot: queued };
    return { kind: "busy" };
  }

  const resolved = resolveBotModelSelection({
    instanceId: input.requested.instanceId,
    model: input.requested.model,
    currentEffort: current.modelSelection.effort,
    requestedEffort: input.requested.effort,
    catalogs,
  });
  if (!resolved.ok) return { kind: "invalid", error: resolved.error };

  const bot = input.patch(current.id, resolved.selection);
  return bot ? { kind: "patched", bot } : { kind: "missing" };
}

/**
 * The paired-safe model switch accepts an advertised instance and model.
 * Effort is optional: omitted keeps the current level when the target still
 * offers it, `null` clears it, and a string must be on that engine's list.
 */
export function parseBotModelPatch(input: unknown): BotModelPatchResult {
  const parsed = modelPatchSchema.safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unsupported?.code === "unrecognized_keys") {
      return { ok: false, error: `unsupported model field: ${unsupported.keys[0] ?? "unknown"}` };
    }
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid model patch" };
  }
  return { ok: true, patch: parsed.data };
}

export function resolveBotModelSelection(input: {
  instanceId: string;
  model: string;
  currentEffort?: EffortLevel;
  requestedEffort?: EffortLevel | null;
  catalogs: readonly AdvertisedInstanceCatalog[];
}): BotModelSelectionResult {
  const instance = input.catalogs.find((candidate) => candidate.instanceId === input.instanceId);
  if (!instance) {
    return { ok: false, error: `unknown provider instance "${input.instanceId}"` };
  }
  const options = instance.models?.options ?? [];
  if (!options.some((option) => option.id === input.model)) {
    return {
      ok: false,
      error: `model "${input.model}" is not advertised by instance "${input.instanceId}"`,
    };
  }

  const selection: ModelSelection = { instanceId: input.instanceId, model: input.model };
  const allowed: readonly string[] = instance.capabilities?.effortLevels ?? [];
  if (input.requestedEffort === null) {
    return { ok: true, selection };
  }
  if (input.requestedEffort !== undefined) {
    if (!allowed.includes(input.requestedEffort) || !isEffortLevel(input.requestedEffort)) {
      return { ok: false, error: `effort "${input.requestedEffort}" is not offered by this bot's engine` };
    }
    selection.effort = input.requestedEffort;
    return { ok: true, selection };
  }
  if (input.currentEffort && allowed.includes(input.currentEffort) && isEffortLevel(input.currentEffort)) {
    selection.effort = input.currentEffort;
  }
  return { ok: true, selection };
}
