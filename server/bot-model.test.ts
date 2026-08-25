import { describe, expect, it } from "vitest";

import { guardedBotModelSwitch, parseBotModelPatch, resolveBotModelSelection } from "./bot-model.ts";

describe("parseBotModelPatch", () => {
  it("accepts only an advertised instance and model pair", () => {
    expect(parseBotModelPatch({ instanceId: "claude", model: "claude-sonnet-5" })).toEqual({
      ok: true,
      patch: { instanceId: "claude", model: "claude-sonnet-5" },
    });
  });

  it("refuses privilege-bearing and catalog-adjacent fields by name", () => {
    for (const field of ["autoApprove", "alwaysAllow", "computer", "effort", "modelSelection", "cwd"]) {
      const result = parseBotModelPatch({ instanceId: "claude", model: "claude-sonnet-5", [field]: true });
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("rejects blank or oversized ids", () => {
    expect(parseBotModelPatch({ instanceId: "", model: "claude-sonnet-5" }).ok).toBe(false);
    expect(parseBotModelPatch({ instanceId: "claude", model: "" }).ok).toBe(false);
    expect(parseBotModelPatch({ instanceId: "x".repeat(201), model: "claude-sonnet-5" }).ok).toBe(false);
    expect(parseBotModelPatch({ instanceId: "claude", model: "m".repeat(501) }).ok).toBe(false);
  });
});

describe("resolveBotModelSelection", () => {
  const catalogs = [
    {
      instanceId: "claude",
      models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    },
    {
      instanceId: "ghost",
      models: { default: "", options: [] },
    },
    {
      instanceId: "plain",
      models: { default: "plain-1", options: [{ id: "plain-1" }] },
    },
  ];

  it("accepts a model from the currently advertised catalog", () => {
    expect(
      resolveBotModelSelection({ instanceId: "claude", model: "claude-haiku-4-5", catalogs }),
    ).toEqual({
      ok: true,
      selection: { instanceId: "claude", model: "claude-haiku-4-5" },
    });
  });

  it("rejects an instance or model that is not advertised", () => {
    expect(resolveBotModelSelection({ instanceId: "missing", model: "claude-sonnet-5", catalogs })).toEqual({
      ok: false,
      error: 'unknown provider instance "missing"',
    });
    expect(resolveBotModelSelection({ instanceId: "claude", model: "made-up", catalogs })).toEqual({
      ok: false,
      error: 'model "made-up" is not advertised by instance "claude"',
    });
    expect(resolveBotModelSelection({ instanceId: "ghost", model: "ghost-1", catalogs })).toEqual({
      ok: false,
      error: 'model "ghost-1" is not advertised by instance "ghost"',
    });
  });

  it("preserves effort only when the target still offers that level", () => {
    expect(
      resolveBotModelSelection({
        instanceId: "claude",
        model: "claude-haiku-4-5",
        currentEffort: "high",
        catalogs,
      }),
    ).toEqual({
      ok: true,
      selection: { instanceId: "claude", model: "claude-haiku-4-5", effort: "high" },
    });

    expect(
      resolveBotModelSelection({
        instanceId: "claude",
        model: "claude-sonnet-5",
        currentEffort: "none",
        catalogs,
      }),
    ).toEqual({
      ok: true,
      selection: { instanceId: "claude", model: "claude-sonnet-5" },
    });

    expect(
      resolveBotModelSelection({
        instanceId: "plain",
        model: "plain-1",
        currentEffort: "high",
        catalogs,
      }),
    ).toEqual({
      ok: true,
      selection: { instanceId: "plain", model: "plain-1" },
    });
  });
});

describe("guardedBotModelSwitch", () => {
  const catalogs = [
    {
      instanceId: "claude",
      models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }] },
      capabilities: { effortLevels: ["low", "medium", "high"] },
    },
  ];

  it("rechecks after catalog resolution so a turn that starts during the await cannot switch models", async () => {
    let bot = {
      id: "bot-1",
      busy: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    };
    let patched = false;

    const result = await guardedBotModelSwitch({
      requested: { instanceId: "claude", model: "claude-haiku-4-5" },
      describe: async () => {
        // Simulate the turn dispatcher winning while the live catalog is
        // still resolving. The current-state callback below is the same
        // store read the HTTP route performs before its synchronous patch.
        bot = { ...bot, busy: true };
        return catalogs;
      },
      current: () => bot,
      patch: () => {
        patched = true;
        return bot;
      },
    });

    expect(result).toEqual({ kind: "busy" });
    expect(patched).toBe(false);
    expect(bot.modelSelection.model).toBe("claude-sonnet-5");
  });

  it("keeps a no-op successful when the bot becomes busy during catalog resolution", async () => {
    let bot = {
      id: "bot-1",
      busy: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    };

    const result = await guardedBotModelSwitch({
      requested: { instanceId: "claude", model: "claude-sonnet-5" },
      describe: async () => {
        bot = { ...bot, busy: true };
        return catalogs;
      },
      current: () => bot,
      patch: () => bot,
    });

    expect(result).toEqual({ kind: "noop", bot });
  });
});
