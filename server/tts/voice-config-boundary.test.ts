import { describe, expect, it, vi } from "vitest";
import { applyVoiceConfigPatch } from "./voice-config.ts";

describe("paired voice credential boundary", () => {
  it("never persists a credential through the new paired metadata route", async () => {
    const save = vi.fn();
    const result = await applyVoiceConfigPatch({ key: "fixture-not-a-real-key" }, {
      systemVoicesAvailable: true, kokoroConfigured: true, save,
    });
    expect(result.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});
