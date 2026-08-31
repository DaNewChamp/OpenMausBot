import { describe, expect, it } from "vitest";
import {
  isRuntimeProfile,
  normalizeRuntimeProfile,
  RUNTIME_PROFILES,
} from "./runtime-profile.ts";

describe("runtime profiles", () => {
  it("keeps the fixed public vocabulary", () => {
    expect(RUNTIME_PROFILES).toEqual([
      "desktop-hub",
      "headless-hub",
      "desktop-client",
    ]);
  });

  it("defaults legacy missing values to desktop-hub", () => {
    expect(normalizeRuntimeProfile(undefined)).toBe("desktop-hub");
    expect(normalizeRuntimeProfile(null)).toBe("desktop-hub");
  });

  it("rejects unknown values instead of publishing them", () => {
    expect(isRuntimeProfile("node-only")).toBe(false);
    expect(() => normalizeRuntimeProfile("node-only")).toThrow(
      "invalid runtime profile",
    );
  });
});
