import { describe, expect, it } from "vitest";

import { fleetSelectionLabel, groupFleetModels } from "./fleet-models";

describe("groupFleetModels", () => {
  it("groups nested models under their machine label", () => {
    const groups = groupFleetModels({
      models: [
        {
          id: "fleet/vincent-pc/dolphin-rp",
          machine: "VincentPC",
          label: "VincentPC (local GPU)",
          server: "ollama",
          baseUrl: "http://192.168.112.215:11434",
          models: [
            { id: "dolphin-rp", name: "dolphin-rp" },
            { id: "llama3-8b", name: "llama3-8b" },
          ],
        },
      ],
    });

    expect(groups).toEqual([
      {
        machine: "VincentPC",
        label: "VincentPC",
        models: [
          { id: "fleet/vincent-pc/dolphin-rp", name: "dolphin-rp" },
          { id: "fleet/vincent-pc/llama3-8b", name: "llama3-8b" },
        ],
      },
    ]);
  });

  it("builds row ids from a machine-prefix id and falls back to the machine name", () => {
    const groups = groupFleetModels({
      models: [
        {
          id: "fleet/macmini",
          machine: "mac mini",
          models: [{ id: "qwen3" }],
        },
      ],
    });
    expect(groups[0].models[0].id).toBe("fleet/macmini/qwen3");
    expect(groups[0].label).toBe("mac mini");
  });

  it("treats a flattened one-row-per-model payload as its own group", () => {
    const groups = groupFleetModels({
      models: [{ id: "fleet/vincent-pc/dolphin-rp", machine: "VincentPC", label: "VincentPC" }],
    });
    expect(groups).toEqual([
      { machine: "VincentPC", label: "VincentPC", models: [{ id: "fleet/vincent-pc/dolphin-rp", name: "dolphin-rp" }] },
    ]);
  });

  it("keeps pre-expanded fleet ids and defaults missing names", () => {
    const groups = groupFleetModels({
      models: [{ id: "fleet/vincent-pc", machine: "VincentPC", models: [{ id: "fleet/vincent-pc/dolphin-rp" }] }],
    });
    expect(groups[0].models[0]).toEqual({ id: "fleet/vincent-pc/dolphin-rp", name: "fleet/vincent-pc/dolphin-rp" });
  });

  it("returns no groups for an empty or malformed payload", () => {
    expect(groupFleetModels({ models: [] })).toEqual([]);
    expect(groupFleetModels({})).toEqual([]);
    expect(groupFleetModels(null)).toEqual([]);
    expect(groupFleetModels({ models: [null, {}, { machine: "X" }] })).toEqual([]);
  });

  it("merges repeated machine entries into one group", () => {
    const groups = groupFleetModels({
      models: [
        { id: "fleet/box/a", machine: "Box", label: "Box", models: [{ id: "a", name: "a" }] },
        { id: "fleet/box/b", machine: "Box", label: "Box", models: [{ id: "b", name: "b" }] },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].models.map((model) => model.id)).toEqual(["fleet/box/a", "fleet/box/b"]);
  });
});

describe("fleetSelectionLabel", () => {
  const groups = groupFleetModels({
    models: [
      { id: "fleet/vincent-pc/dolphin-rp", machine: "VincentPC", label: "VincentPC (local GPU)", models: [{ id: "dolphin-rp", name: "dolphin-rp" }] },
    ],
  });

  it("prefers the machine and model names from the fetch", () => {
    expect(fleetSelectionLabel(groups, "fleet/vincent-pc/dolphin-rp")).toBe("VincentPC · dolphin-rp");
  });

  it("parses an unseen fleet id as machine/model", () => {
    expect(fleetSelectionLabel(groups, "fleet/other-box/qwen3")).toBe("other-box/qwen3");
    expect(fleetSelectionLabel([], "fleet/vincent-pc/dolphin-rp")).toBe("vincent-pc/dolphin-rp");
  });

  it("falls back to the raw string when it is not a fleet id", () => {
    expect(fleetSelectionLabel([], "dolphin-rp")).toBe("dolphin-rp");
  });
});
