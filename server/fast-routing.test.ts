import { describe, expect, it } from "vitest";

import { resolveFastDispatch } from "./fast-routing.ts";

describe("resolveFastDispatch", () => {
  const catalog = [
    {
      instanceId: "codex",
      driverKind: "codex",
      models: { default: "gpt-5.6-sol", options: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.3-codex-spark" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    },
    {
      instanceId: "claude",
      driverKind: "claudeAgent",
      models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    },
    {
      instanceId: "grok",
      driverKind: "grok",
      models: { default: "grok-4", options: [{ id: "grok-4" }, { id: "grok-4-fast" }] },
    },
  ] as const;

  it("prefers codex with spark and low effort when available", () => {
    expect(
      resolveFastDispatch({
        stored: { instanceId: "grok", model: "grok-4" },
        instances: catalog,
      }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.3-codex-spark",
      effort: "low",
    });
  });

  it("falls back to claude when codex is unavailable", () => {
    expect(
      resolveFastDispatch({
        stored: { instanceId: "grok", model: "grok-4" },
        instances: catalog.filter((row) => row.instanceId !== "codex"),
      }),
    ).toEqual({
      instanceId: "claude",
      model: "claude-haiku-4-5",
      effort: "low",
    });
  });

  it("speeds up the stored engine when no priority match exists", () => {
    expect(
      resolveFastDispatch({
        stored: { instanceId: "grok", model: "grok-4", effort: "high" },
        instances: [{ instanceId: "grok", driverKind: "grok", models: catalog[2].models }],
      }),
    ).toEqual({
      instanceId: "grok",
      model: "grok-4-fast",
    });
  });
});
