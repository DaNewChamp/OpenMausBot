import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "./ModelPicker";
import { StoreContext } from "@/state/store";
import {
  createModelDraft,
  browseProvider,
  selectModelInDraft,
  toggleFastInDraft,
  toggleOneMInDraft,
  setEffortInDraft,
  isDraftDirty,
  buildModelFamilies,
} from "@/lib/model-family";

function makeMockStore(overrides?: any): any {
  const defaultState: any = {
    bots: [
      {
        id: "bot-1",
        name: "Assistant",
        modelSelection: {
          instanceId: "claude-inst",
          model: "claude-3-5-haiku",
        },
      },
    ],
    instances: [
      {
        instanceId: "claude-inst",
        displayName: "Claude",
        driverKind: "claude",
        snapshot: { version: "1.0", isAvailable: true },
        models: {
          default: "claude-3-5-haiku",
          options: [
            { id: "claude-3-5-haiku", label: "Claude 3.5 Haiku" },
            { id: "claude-3-5-haiku-fast", label: "Claude 3.5 Haiku Fast" },
            { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet" },
          ],
        },
        capabilities: { effortLevels: ["low", "medium", "high"] },
      },
      {
        instanceId: "openai-inst",
        displayName: "OpenAI",
        driverKind: "openai",
        snapshot: { version: "1.0", isAvailable: true },
        models: {
          default: "gpt-4o",
          options: [
            { id: "gpt-4o", label: "GPT-4o" },
            { id: "gpt-4o-mini", label: "GPT-4o mini" },
            { id: "gpt-4o-mini-1m", label: "GPT-4o mini 1M" },
          ],
        },
      },
    ],
    engineSync: null,
  };

  return {
    state: defaultState,
    dispatch: vi.fn(),
    refreshInstances: vi.fn().mockResolvedValue(undefined),
    refreshEngineSync: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe("ModelPicker iOS semantics", () => {
  it("renders trigger with active selection and supports open dialog rendering", () => {
    const mockStore = makeMockStore();
    const bot = mockStore.state.bots[0];

    const htmlClosed = renderToStaticMarkup(
      <StoreContext.Provider value={mockStore}>
        <ModelPicker bot={bot} />
      </StoreContext.Provider>
    );

    expect(htmlClosed).toContain("Claude 3.5 Haiku");

    const htmlOpen = renderToStaticMarkup(
      <StoreContext.Provider value={mockStore}>
        <ModelPicker bot={bot} initialOpen />
      </StoreContext.Provider>
    );

    expect(htmlOpen).toContain("Choose model");
    expect(htmlOpen).toContain("Fast generation");
    expect(htmlOpen).toContain("Reasoning:");
    expect(htmlOpen).toContain("Apply");
    expect(htmlOpen).toContain("Cancel");
  });

  it("verifies provider browse without save semantics", () => {
    const mockStore = makeMockStore();
    const initialSelection = {
      instanceId: "claude-inst",
      model: "claude-3-5-haiku",
    };

    let draft = createModelDraft(initialSelection, mockStore.state.instances);
    expect(draft.browsingRailId).toBe("claude-inst");
    expect(isDraftDirty(draft)).toBe(false);

    // Browsing another provider rail must not change draft selection or mark draft dirty
    draft = browseProvider(draft, "openai-inst");
    expect(draft.browsingRailId).toBe("openai-inst");
    expect(draft.draftInstanceId).toBe("claude-inst");
    expect(draft.draftModel).toBe("claude-3-5-haiku");
    expect(isDraftDirty(draft)).toBe(false);
  });

  it("verifies draft selection and supported same-model Fast / 1M / reasoning controls", () => {
    const mockStore = makeMockStore();
    const instances = mockStore.state.instances;
    const families = buildModelFamilies(instances);
    const haikuFamily = families.find((f) => f.key === "claude-3-5-haiku")!;
    const gptMiniFamily = families.find((f) => f.key === "gpt-4o-mini")!;

    const initialSelection = {
      instanceId: "claude-inst",
      model: "claude-3-5-haiku",
    };

    let draft = createModelDraft(initialSelection, instances);

    // Fast toggle
    draft = toggleFastInDraft(draft, haikuFamily);
    expect(draft.draftFast).toBe(true);
    expect(draft.draftModel).toBe("claude-3-5-haiku-fast");
    expect(isDraftDirty(draft)).toBe(true);

    // Switch model to GPT-4o mini
    draft = selectModelInDraft(draft, gptMiniFamily, "openai-inst", "gpt-4o-mini");
    expect(draft.draftInstanceId).toBe("openai-inst");
    expect(draft.draftModel).toBe("gpt-4o-mini");

    // 1M context toggle
    draft = toggleOneMInDraft(draft, gptMiniFamily);
    expect(draft.draftOneM).toBe(true);
    expect(draft.draftModel).toBe("gpt-4o-mini-1m");

    // Reasoning effort control
    draft = setEffortInDraft(draft, haikuFamily, "high");
    expect(draft.draftEffort).toBe("high");
    expect(isDraftDirty(draft)).toBe(true);
  });
});
