// Finding an engine that can answer a short question.
//
// `generateText` is optional on ProviderInstance and only some drivers have
// it, so a bot on codex or an ACP engine has to borrow one. The rules being
// pinned down here: prefer the engine the user actually chose for that bot,
// fall back to any that can, and when none can say so plainly rather than
// pretending — a caller that gets null turns its feature off instead of
// hanging or guessing.
import { describe, expect, it, vi } from "vitest";

import { askHelper, resolveHelper, type HelperCapable } from "./helper-instance.ts";

const capable = (instanceId: string, answer = "ok"): HelperCapable => ({
  instanceId,
  generateText: () => Promise.resolve(answer),
});
const incapable = (instanceId: string): HelperCapable => ({ instanceId });

describe("resolveHelper", () => {
  it("prefers the bot's own instance when it can answer", () => {
    const all = [capable("claude"), capable("grok")];
    expect(resolveHelper("grok", all)?.instanceId).toBe("grok");
  });

  it("borrows any capable instance when the bot's own cannot", () => {
    const all = [incapable("codex"), capable("claude")];
    expect(resolveHelper("codex", all)?.instanceId).toBe("claude");
  });

  it("returns null when nothing can answer", () => {
    expect(resolveHelper("codex", [incapable("codex"), incapable("droid")])).toBeNull();
  });

  it("returns null for an empty fleet", () => {
    expect(resolveHelper("claude", [])).toBeNull();
  });

  it("copes with a preferred id that is not in the fleet", () => {
    expect(resolveHelper("deleted", [capable("claude")])?.instanceId).toBe("claude");
  });

  it("copes with no preference at all", () => {
    expect(resolveHelper(undefined, [capable("claude")])?.instanceId).toBe("claude");
  });
});

describe("askHelper", () => {
  it("returns the answer, trimmed", async () => {
    expect(await askHelper(capable("claude", "  yes  "), "q", 1_000)).toBe("yes");
  });

  it("returns null on a rejection rather than throwing at the caller", async () => {
    const helper: HelperCapable = { instanceId: "claude", generateText: () => Promise.reject(new Error("upstream down")) };
    expect(await askHelper(helper, "q", 1_000)).toBeNull();
  });

  it("returns null rather than hanging when the engine is slow", async () => {
    vi.useFakeTimers();
    const helper: HelperCapable = { instanceId: "claude", generateText: () => new Promise(() => {}) };
    const pending = askHelper(helper, "q", 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBeNull();
    vi.useRealTimers();
  });

  it("treats a whitespace-only answer as no answer", async () => {
    expect(await askHelper(capable("claude", "   \n "), "q", 1_000)).toBeNull();
  });

  it("returns null when the instance cannot generate at all", async () => {
    expect(await askHelper(incapable("codex"), "q", 1_000)).toBeNull();
  });
});
