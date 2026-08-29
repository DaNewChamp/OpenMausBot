import type { EffortLevel, ModelSelection } from "./contracts.ts";
import { isEffortLevel } from "./contracts.ts";

/** Engines tried in order when fast mode is on. Codex first, Claude/Cursor
 * second, Grok-family third — then whatever the bot already picked. */
export const FAST_DRIVER_PRIORITY = [
  "codex",
  "claudeAgent",
  "cursorAgent",
  "grokAgent",
  "grok",
] as const;

const FAST_MODEL_HINT = /(?:^|[._:-])(?:spark|mini|fast|luna|haiku|flash|composer-2\.5-fast)(?:$|[._:-])/i;

const PREFERRED_BY_KIND: Record<string, readonly string[]> = {
  codex: ["gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-sol"],
  claudeAgent: ["claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-4-6"],
  cursorAgent: ["composer-2.5-fast", "auto"],
  grokAgent: ["grok-composer-2.5-fast", "grok-4-fast", "grok-4.5"],
  grok: ["grok-4-fast", "grok-3-mini", "grok-4"],
};

export interface FastRoutingInstance {
  instanceId: string;
  driverKind: string;
  models?: { default?: string; options?: Array<{ id?: string }> };
  capabilities?: { effortLevels?: readonly string[] };
  available?: boolean;
}

function modelOptions(instance: FastRoutingInstance): string[] {
  const options = instance.models?.options ?? [];
  return options.map((row) => row.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

function pickFastModel(instance: FastRoutingInstance, storedModel?: string): string {
  const options = modelOptions(instance);
  if (!options.length) return instance.models?.default ?? storedModel ?? "";
  const preferred = PREFERRED_BY_KIND[instance.driverKind] ?? [];
  for (const id of preferred) {
    const exact = options.find((option) => option === id || option.endsWith(`::${id}`));
    if (exact) return exact;
  }
  const hinted = options.find((option) => FAST_MODEL_HINT.test(option));
  if (hinted) return hinted;
  if (storedModel && options.includes(storedModel)) return storedModel;
  return instance.models?.default && options.includes(instance.models.default)
    ? instance.models.default
    : options[0]!;
}

function pickFastEffort(instance: FastRoutingInstance): EffortLevel | undefined {
  const levels = instance.capabilities?.effortLevels ?? [];
  if (levels.includes("low") && isEffortLevel("low")) return "low";
  if (levels.includes("medium") && isEffortLevel("medium")) return "medium";
  return undefined;
}

function liveInstances(instances: readonly FastRoutingInstance[]): FastRoutingInstance[] {
  return instances.filter((instance) => instance.available !== false);
}

/** Resolve the engine + model used for a turn when fast mode is enabled.
 * Stored selection stays on disk; this only affects dispatch. */
export function resolveFastDispatch(input: {
  stored: ModelSelection;
  instances: readonly FastRoutingInstance[];
}): ModelSelection | null {
  const live = liveInstances(input.instances);
  if (!live.length) return null;

  for (const kind of FAST_DRIVER_PRIORITY) {
    const match = live.find((instance) => instance.driverKind === kind);
    if (!match) continue;
    const model = pickFastModel(match, input.stored.model);
    if (!model) continue;
    const effort = pickFastEffort(match);
    return effort ? { instanceId: match.instanceId, model, effort } : { instanceId: match.instanceId, model };
  }

  const current = live.find((instance) => instance.instanceId === input.stored.instanceId);
  if (!current) return null;
  const model = pickFastModel(current, input.stored.model);
  if (!model) return null;
  const effort = pickFastEffort(current) ?? input.stored.effort;
  return effort ? { instanceId: current.instanceId, model, effort } : { instanceId: current.instanceId, model };
}

export function fastRoutingLabel(selection: ModelSelection, instances: readonly FastRoutingInstance[]): string | null {
  const instance = instances.find((row) => row.instanceId === selection.instanceId);
  if (!instance) return null;
  const model = selection.model.split("::").pop() ?? selection.model;
  const effort = selection.effort ? ` · ${selection.effort}` : "";
  return `${instance.driverKind} · ${model}${effort}`;
}
