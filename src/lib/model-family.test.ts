import { describe, expect, it } from "vitest";
import {
  parseModelId,
  buildModelFamilies,
  resolveVariant,
  createModelDraft,
  browseProvider,
  selectModelInDraft,
  toggleFastInDraft,
  toggleOneMInDraft,
  setEffortInDraft,
  isDraftDirty,
} from "./model-family";
import type { InstanceInfo } from "@/state/store";

describe("model-family parsing and resolution", () => {
  it("parses model ID into family key and variant axes", () => {
    expect(parseModelId("claude-3-7-sonnet")).toEqual({
      familyKey: "claude-3-7-sonnet",
      axes: { effort: undefined, thinking: false, fast: false, oneM: false },
    });

    expect(parseModelId("claude-3-7-sonnet-thinking")).toEqual({
      familyKey: "claude-3-7-sonnet",
      axes: { effort: undefined, thinking: true, fast: false, oneM: false },
    });

    expect(parseModelId("claude-3-5-haiku-fast")).toEqual({
      familyKey: "claude-3-5-haiku",
      axes: { effort: undefined, thinking: false, fast: true, oneM: false },
    });

    expect(parseModelId("gpt-4o-mini-1m")).toEqual({
      familyKey: "gpt-4o-mini",
      axes: { effort: undefined, thinking: false, fast: false, oneM: true },
    });

    expect(parseModelId("gpt-5-high")).toEqual({
      familyKey: "gpt-5",
      axes: { effort: "high", thinking: false, fast: false, oneM: false },
    });

    expect(parseModelId("gpt-5-extra-high")).toEqual({
      familyKey: "gpt-5",
      axes: { effort: "extra-high", thinking: false, fast: false, oneM: false },
    });
  });

  const sampleInstances: InstanceInfo[] = [
    {
      instanceId: "claude-main",
      displayName: "Claude",
      driverKind: "claude",
      snapshot: { version: "1.0", state: "available" },
      models: {
        default: "claude-3-7-sonnet",
        options: [
          { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet" },
          { id: "claude-3-7-sonnet-thinking", label: "Claude 3.7 Sonnet (Thinking)" },
          { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku" },
          { id: "claude-3-5-haiku-fast", label: "Claude 3.5 Haiku Fast" },
        ],
      },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    },
    {
      instanceId: "openai-cloud",
      displayName: "OpenAI",
      driverKind: "openai",
      snapshot: { version: "1.0", state: "available" },
      models: {
        default: "gpt-4o",
        options: [
          { id: "gpt-4o", label: "GPT-4o" },
          { id: "gpt-4o-mini", label: "GPT-4o mini" },
          { id: "gpt-4o-mini-1m", label: "GPT-4o mini 1M" },
          { id: "gpt-5-low", label: "GPT-5 Low" },
          { id: "gpt-5-high", label: "GPT-5 High" },
        ],
      },
    },
  ];

  it("groups variants into families across instances", () => {
    const families = buildModelFamilies(sampleInstances);
    const haikuFamily = families.find((f) => f.key === "claude-3-5-haiku");
    expect(haikuFamily).toBeDefined();
    expect(haikuFamily?.label).toBe("Claude 3.5 Haiku");
    expect(haikuFamily?.sources[0].variants).toHaveLength(2);
  });

  it("resolves exact variant when toggling same-model Fast or 1M context", () => {
    const families = buildModelFamilies(sampleInstances);
    const haikuFamily = families.find((f) => f.key === "claude-3-5-haiku")!;

    const fastVariant = resolveVariant(haikuFamily, "claude-main", { fast: true });
    expect(fastVariant?.modelId).toBe("claude-3-5-haiku-fast");

    const normalVariant = resolveVariant(haikuFamily, "claude-main", { fast: false });
    expect(normalVariant?.modelId).toBe("claude-3-5-haiku");

    const gptMiniFamily = families.find((f) => f.key === "gpt-4o-mini")!;
    const oneMVariant = resolveVariant(gptMiniFamily, "openai-cloud", { oneM: true });
    expect(oneMVariant?.modelId).toBe("gpt-4o-mini-1m");
  });

  it("supports provider browsing without mutating draft selection", () => {
    const initial = {
      instanceId: "claude-main",
      model: "claude-3-7-sonnet",
      effort: "medium",
    };

    let draft = createModelDraft(initial, sampleInstances);
    expect(draft.browsingRailId).toBe("claude-main");
    expect(draft.draftInstanceId).toBe("claude-main");
    expect(draft.draftModel).toBe("claude-3-7-sonnet");
    expect(isDraftDirty(draft)).toBe(false);

    // Browse to OpenAI without saving or mutating draft model
    draft = browseProvider(draft, "openai-cloud");
    expect(draft.browsingRailId).toBe("openai-cloud");
    expect(draft.draftInstanceId).toBe("claude-main");
    expect(draft.draftModel).toBe("claude-3-7-sonnet");
    expect(isDraftDirty(draft)).toBe(false);
  });

  it("supports explicit model selection, Fast toggle, 1M toggle, effort, and source controls", () => {
    const families = buildModelFamilies(sampleInstances);
    const initial = {
      instanceId: "claude-main",
      model: "claude-3-5-haiku",
    };

    let draft = createModelDraft(initial, sampleInstances);

    // Toggle same-model Fast
    const haikuFamily = families.find((f) => f.key === "claude-3-5-haiku")!;
    draft = toggleFastInDraft(draft, haikuFamily);
    expect(draft.draftFast).toBe(true);
    expect(draft.draftModel).toBe("claude-3-5-haiku-fast");
    expect(isDraftDirty(draft)).toBe(true);

    // Toggle Fast back off
    draft = toggleFastInDraft(draft, haikuFamily);
    expect(draft.draftFast).toBe(false);
    expect(draft.draftModel).toBe("claude-3-5-haiku");

    // Select GPT-4o mini and toggle 1M context
    const gptMiniFamily = families.find((f) => f.key === "gpt-4o-mini")!;
    draft = selectModelInDraft(draft, gptMiniFamily, "openai-cloud", "gpt-4o-mini");
    expect(draft.draftInstanceId).toBe("openai-cloud");
    expect(draft.draftModel).toBe("gpt-4o-mini");
    expect(isDraftDirty(draft)).toBe(true);

    draft = toggleOneMInDraft(draft, gptMiniFamily);
    expect(draft.draftOneM).toBe(true);
    expect(draft.draftModel).toBe("gpt-4o-mini-1m");

    // Change effort level
    draft = setEffortInDraft(draft, gptMiniFamily, "high");
    expect(draft.draftEffort).toBe("high");
  });
});
