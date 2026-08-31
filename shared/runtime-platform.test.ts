import { describe, expect, it } from "vitest";
import { WIRE_PLATFORMS, normalizeWirePlatform } from "./runtime-platform.ts";

describe("wire platforms", () => {
  it("keeps the canonical transport vocabulary", () => {
    expect(WIRE_PLATFORMS).toEqual(["darwin", "windows", "linux"]);
  });

  it("maps Node win32 to windows at the runtime boundary", () => {
    expect(normalizeWirePlatform("win32")).toBe("windows");
    expect(normalizeWirePlatform("windows")).toBe("windows");
  });

  it("rejects unknown process or wire values", () => {
    expect(() => normalizeWirePlatform("aix")).toThrow("invalid wire platform");
  });
});
