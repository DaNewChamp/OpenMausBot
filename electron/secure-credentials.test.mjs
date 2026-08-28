// The rule this module exists to enforce: "I could not read the store" and
// "the store is empty" are DIFFERENT ANSWERS. Collapsing them is what made a
// keychain hiccup look like the user had never connected anything.
import { describe, expect, it, vi } from "vitest";

import { readSecureCredentials } from "./secure-credentials.mjs";

const transient = () =>
  new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again.");

/** deps with sane defaults; each test overrides the one thing it is about */
const deps = (over = {}) => ({
  exists: () => true,
  isAvailable: async () => true,
  readFile: () => Buffer.from("cipher"),
  decrypt: async () => JSON.stringify({ composioApiKey: "ak_live" }),
  sleep: async () => {},
  ...over,
});

describe("readSecureCredentials", () => {
  it("reports an empty store when no file was ever written", async () => {
    const result = await readSecureCredentials(deps({ exists: () => false }));
    expect(result).toEqual({ status: "empty", credentials: {} });
  });

  it("returns the stored credentials when the store opens", async () => {
    const result = await readSecureCredentials(deps());
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("tries again when the OS says the store is temporarily unavailable", async () => {
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(JSON.stringify({ composioApiKey: "ak_live" }));
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("waits between attempts instead of hammering the keychain", async () => {
    const slept = [];
    const decrypt = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("{}");
    await readSecureCredentials(deps({ decrypt, sleep: async (ms) => slept.push(ms) }));
    expect(slept).toEqual([100]);
  });

  it("says UNAVAILABLE — never empty — when every attempt fails", async () => {
    const decrypt = vi.fn().mockRejectedValue(transient());
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
    expect(result.error).toMatch(/temporarily unavailable/);
    expect(decrypt.mock.calls.length).toBeGreaterThan(1);
  });

  it("says UNAVAILABLE when the OS store itself is switched off", async () => {
    const result = await readSecureCredentials(deps({ isAvailable: async () => false }));
    expect(result.status).toBe("unavailable");
  });

  it("says UNAVAILABLE for a file it cannot parse, rather than pretending it is empty", async () => {
    // retrying cannot fix corruption, but calling it "empty" would invite the
    // caller to register a fresh identity over the top of it
    const decrypt = vi.fn().mockResolvedValue("not json");
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it("says UNAVAILABLE when the keychain never answers, rather than stalling boot", async () => {
    const abortNow = () => {
      const controller = new AbortController();
      queueMicrotask(() => controller.abort());
      return controller.signal;
    };
    const isAvailable = vi.fn(() => new Promise(() => {}));
    const decrypt = vi.fn(() => new Promise(() => {}));
    const result = await readSecureCredentials(
      deps({
        isAvailable,
        decrypt,
        timeoutSignal: abortNow,
        delays: [0, 0],
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
    expect(result.error).toMatch(/did not respond in time/);
    expect(isAvailable.mock.calls.length).toBeGreaterThan(1);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("times out a hung decrypt after the store claims it is available", async () => {
    const decrypt = vi.fn(() => new Promise(() => {}));
    const result = await readSecureCredentials(
      deps({
        decrypt,
        timeoutMs: 20,
        delays: [0],
      }),
    );
    expect(result.status).toBe("unavailable");
    expect(result.error).toMatch(/did not respond in time/);
    expect(decrypt.mock.calls.length).toBeGreaterThan(1);
  });
});
