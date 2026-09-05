import { describe, expect, it, vi } from "vitest";
import { applyVoiceConfigPatch, validateVoiceConfigPatch } from "./voice-config.ts";

const ready = { systemVoicesAvailable: true, kokoroConfigured: true };

describe("paired voice metadata", () => {
  it("accepts a provider and fallback voice without credentials", () => {
    expect(validateVoiceConfigPatch({ provider: "kokoro", voice: " af_heart " }, ready)).toEqual({
      ok: true, patch: { provider: "kokoro", voice: "af_heart" },
    });
  });
  it.each(["key", "baseUrl", "url", "endpoint", "model", "headers", "method", "extra", "constructor", "__proto__"])("rejects %s rather than expanding host configuration", (key) => {
    const body = JSON.parse(`{"provider":"kokoro","${key}":"untrusted"}`);
    const result = validateVoiceConfigPatch(body, ready);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only provider and voice/i);
  });
  it("rejects a Mac provider on another platform", () => {
    expect(validateVoiceConfigPatch({ provider: "system" }, { ...ready, systemVoicesAvailable: false }).ok).toBe(false);
  });
  it("rejects Kokoro when the operator has not configured an endpoint", () => {
    const result = validateVoiceConfigPatch({ provider: "kokoro" }, { ...ready, kokoroConfigured: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("OMB_KOKORO_BASE_URL");
  });
  it.each([{}, [], null, { provider: "cartesia" }, { provider: 1 }, { provider: undefined }, { voice: "" }, { voice: "x".repeat(201) }, { voice: "invalid\nvoice" }, { voice: null }])("rejects malformed metadata %j", (body) => {
    expect(validateVoiceConfigPatch(body, ready).ok).toBe(false);
  });
  it("does not save partial valid fields when another field is invalid", async () => {
    const save = vi.fn();
    const result = await applyVoiceConfigPatch({ provider: "kokoro", key: "fixture-secret" }, { ...ready, save });
    expect(result.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
  it("persists exactly the requested metadata", async () => {
    const save = vi.fn();
    expect(await applyVoiceConfigPatch({ provider: "kokoro", voice: "af_heart" }, { ...ready, save })).toEqual({
      ok: true, patch: { tts: { provider: "kokoro", voice: "af_heart" } },
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({ tts: { provider: "kokoro", voice: "af_heart" } });
  });
});
