import type { InstanceInfo } from "@/state/store";

export interface ModelVariantAxes {
  effort?: string;
  thinking: boolean;
  fast: boolean;
  oneM: boolean;
}

export interface ParsedModelId {
  familyKey: string;
  axes: ModelVariantAxes;
}

export interface ModelAdvertisedVariant {
  instanceId: string;
  modelId: string;
  label: string;
  axes: ModelVariantAxes;
  privacyNotice?: string;
}

export interface ModelFamilySource {
  instanceId: string;
  displayName: string;
  available: boolean;
  unavailableReason?: string;
  variants: ModelAdvertisedVariant[];
  capabilityEffortLevels: string[];
  effortEncodedInModelId: boolean;
}

export interface ModelFamily {
  key: string;
  providerId: string;
  label: string;
  sources: ModelFamilySource[];
}

export interface ModelDraftState {
  browsingRailId: string;
  draftInstanceId: string;
  draftModel: string;
  draftEffort?: string;
  draftFast: boolean;
  draftOneM: boolean;
  draftThinking: boolean;
  initialSelection: {
    instanceId: string;
    model: string;
    effort?: string;
  };
}

const EFFORT_TOKENS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function parseModelId(modelId: string): ParsedModelId {
  const trimmed = (modelId || "").trim();
  if (!trimmed) {
    return {
      familyKey: "",
      axes: { effort: undefined, thinking: false, fast: false, oneM: false },
    };
  }

  const lower = trimmed.toLowerCase();
  const allowedPrefixes = ["gpt-", "claude-", "composer-"];
  if (!allowedPrefixes.some((prefix) => lower.startsWith(prefix)) || trimmed.includes("/")) {
    return {
      familyKey: trimmed,
      axes: { effort: undefined, thinking: false, fast: false, oneM: false },
    };
  }

  const tokens = trimmed.split("-");
  let effort: string | undefined;
  let thinking = false;
  let fast = false;
  let explicitOneM = false;

  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1].toLowerCase();
    if (last === "fast" && !fast) {
      fast = true;
      tokens.pop();
      continue;
    }
    if (last === "1m" && !explicitOneM) {
      explicitOneM = true;
      tokens.pop();
      continue;
    }
    if (last === "thinking" && !thinking) {
      thinking = true;
      tokens.pop();
      continue;
    }
    if (!effort && last === "high" && tokens.length > 2 && tokens[tokens.length - 2].toLowerCase() === "extra") {
      effort = "extra-high";
      tokens.splice(tokens.length - 2, 2);
      continue;
    }
    if (!effort && EFFORT_TOKENS.has(last)) {
      effort = last;
      tokens.pop();
      continue;
    }
    break;
  }

  const familyKey = tokens.join("-") || trimmed;
  return {
    familyKey,
    axes: { effort, thinking, fast, oneM: explicitOneM },
  };
}

export function cleanFamilyLabel(label: string): string {
  let text = label.trim();
  const noticeMatch = text.match(/\(([^)]+)\)/);
  if (noticeMatch && (noticeMatch[1].toUpperCase().includes("ZDR") || noticeMatch[1].toUpperCase().includes("PRIVACY"))) {
    text = text.replace(noticeMatch[0], "").trim();
  }

  const strips = [
    /\s+1M\s+Thinking/gi,
    /\s+\(Thinking\)/gi,
    /\s+Thinking/gi,
    /\s+Extra\s+High/gi,
    /\s+X-High/gi,
    /\s+1M/gi,
    /\s+Fast/gi,
    /\s+None/gi,
    /\s+Low/gi,
    /\s+Medium/gi,
    /\s+High/gi,
    /\s+Max/gi,
  ];

  for (const pattern of strips) {
    text = text.replace(pattern, "");
  }

  return text.trim().replace(/\s+/g, " ");
}

export function buildModelFamilies(instances: InstanceInfo[]): ModelFamily[] {
  const buckets = new Map<string, Map<string, ModelAdvertisedVariant[]>>();
  const sourceMeta = new Map<
    string,
    { displayName: string; available: boolean; reason?: string; effortLevels: string[] }
  >();

  for (const instance of instances) {
    sourceMeta.set(instance.instanceId, {
      displayName: instance.displayName,
      available: instance.snapshot.state === "available",
      reason: instance.snapshot.reason,
      effortLevels: instance.capabilities?.effortLevels ? [...instance.capabilities.effortLevels] : [],
    });

    for (const option of instance.models.options) {
      const parsed = parseModelId(option.id);
      const providerId = instance.driverKind || instance.instanceId;
      if (!buckets.has(providerId)) {
        buckets.set(providerId, new Map());
      }
      const providerMap = buckets.get(providerId)!;
      if (!providerMap.has(parsed.familyKey)) {
        providerMap.set(parsed.familyKey, []);
      }
      providerMap.get(parsed.familyKey)!.push({
        instanceId: instance.instanceId,
        modelId: option.id,
        label: option.label,
        axes: parsed.axes,
      });
    }
  }

  const families: ModelFamily[] = [];

  for (const [providerId, providerMap] of buckets) {
    for (const [key, variants] of providerMap) {
      const bySource = new Map<string, ModelAdvertisedVariant[]>();
      for (const variant of variants) {
        if (!bySource.has(variant.instanceId)) {
          bySource.set(variant.instanceId, []);
        }
        bySource.get(variant.instanceId)!.push(variant);
      }

      const sources: ModelFamilySource[] = Array.from(bySource.keys())
        .sort()
        .map((instanceId) => {
          const rows = bySource.get(instanceId) || [];
          const meta = sourceMeta.get(instanceId);
          return {
            instanceId,
            displayName: meta?.displayName ?? instanceId,
            available: meta?.available ?? false,
            unavailableReason: meta?.available ? undefined : meta?.reason,
            variants: rows,
            capabilityEffortLevels: meta?.effortLevels ?? [],
            effortEncodedInModelId: rows.some((r) => Boolean(r.axes.effort)),
          };
        });

      const firstLabel = variants[0]?.label || key;
      const label = cleanFamilyLabel(firstLabel);

      families.push({
        key,
        providerId,
        label,
        sources,
      });
    }
  }

  return families;
}

export function resolveVariant(
  family: ModelFamily,
  instanceId: string,
  axes: Partial<ModelVariantAxes>
): ModelAdvertisedVariant | undefined {
  const source = family.sources.find((s) => s.instanceId === instanceId);
  if (!source) return undefined;

  const targetThinking = axes.thinking ?? false;
  const targetFast = axes.fast ?? false;
  const targetOneM = axes.oneM ?? false;

  const matches = source.variants.filter((v) => {
    if (v.axes.thinking !== targetThinking) return false;
    if (v.axes.fast !== targetFast) return false;
    if (v.axes.oneM !== targetOneM) return false;
    if (source.effortEncodedInModelId && axes.effort) {
      return v.axes.effort === axes.effort;
    }
    return true;
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return matches.reduce((best, cur) => (cur.modelId.length < best.modelId.length ? cur : best));
  }

  // Fallback: match fast and oneM
  const fallback = source.variants.filter(
    (v) => v.axes.fast === targetFast && v.axes.oneM === targetOneM
  );
  if (fallback.length > 0) return fallback[0];

  return source.variants[0];
}

export function createModelDraft(
  initial: { instanceId: string; model: string; effort?: string },
  _instances?: InstanceInfo[]
): ModelDraftState {
  const parsed = parseModelId(initial.model);
  return {
    browsingRailId: initial.instanceId,
    draftInstanceId: initial.instanceId,
    draftModel: initial.model,
    draftEffort: initial.effort ?? parsed.axes.effort,
    draftFast: parsed.axes.fast,
    draftOneM: parsed.axes.oneM,
    draftThinking: parsed.axes.thinking,
    initialSelection: {
      instanceId: initial.instanceId,
      model: initial.model,
      effort: initial.effort,
    },
  };
}

export function browseProvider(draft: ModelDraftState, railId: string): ModelDraftState {
  return {
    ...draft,
    browsingRailId: railId,
  };
}

export function selectModelInDraft(
  draft: ModelDraftState,
  _family: ModelFamily,
  instanceId: string,
  modelId: string
): ModelDraftState {
  const parsed = parseModelId(modelId);
  return {
    ...draft,
    draftInstanceId: instanceId,
    draftModel: modelId,
    draftFast: parsed.axes.fast,
    draftOneM: parsed.axes.oneM,
    draftThinking: parsed.axes.thinking,
    draftEffort: parsed.axes.effort ?? draft.draftEffort,
  };
}

export function toggleFastInDraft(draft: ModelDraftState, family: ModelFamily): ModelDraftState {
  const nextFast = !draft.draftFast;
  const variant = resolveVariant(family, draft.draftInstanceId, {
    fast: nextFast,
    oneM: draft.draftOneM,
    thinking: draft.draftThinking,
    effort: draft.draftEffort,
  });

  return {
    ...draft,
    draftFast: nextFast,
    draftModel: variant ? variant.modelId : draft.draftModel,
  };
}

export function toggleOneMInDraft(draft: ModelDraftState, family: ModelFamily): ModelDraftState {
  const nextOneM = !draft.draftOneM;
  const variant = resolveVariant(family, draft.draftInstanceId, {
    fast: draft.draftFast,
    oneM: nextOneM,
    thinking: draft.draftThinking,
    effort: draft.draftEffort,
  });

  return {
    ...draft,
    draftOneM: nextOneM,
    draftModel: variant ? variant.modelId : draft.draftModel,
  };
}

export function setEffortInDraft(
  draft: ModelDraftState,
  family: ModelFamily,
  effort?: string
): ModelDraftState {
  const source = family.sources.find((s) => s.instanceId === draft.draftInstanceId);
  let nextModel = draft.draftModel;
  if (source?.effortEncodedInModelId) {
    const variant = resolveVariant(family, draft.draftInstanceId, {
      fast: draft.draftFast,
      oneM: draft.draftOneM,
      thinking: draft.draftThinking,
      effort,
    });
    if (variant) nextModel = variant.modelId;
  }

  return {
    ...draft,
    draftEffort: effort,
    draftModel: nextModel,
  };
}

export function selectSourceInDraft(
  draft: ModelDraftState,
  family: ModelFamily,
  newInstanceId: string
): ModelDraftState {
  const variant = resolveVariant(family, newInstanceId, {
    fast: draft.draftFast,
    oneM: draft.draftOneM,
    thinking: draft.draftThinking,
    effort: draft.draftEffort,
  });

  return {
    ...draft,
    draftInstanceId: newInstanceId,
    draftModel: variant ? variant.modelId : draft.draftModel,
  };
}

export function isDraftDirty(draft: ModelDraftState): boolean {
  return (
    draft.draftInstanceId !== draft.initialSelection.instanceId ||
    draft.draftModel !== draft.initialSelection.model ||
    (draft.draftEffort ?? undefined) !== (draft.initialSelection.effort ?? undefined)
  );
}
