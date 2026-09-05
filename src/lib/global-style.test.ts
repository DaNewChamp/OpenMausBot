import { describe, expect, it } from "vitest";
import {
  GLOBAL_STYLE_SECTION_FOOTER,
  GLOBAL_STYLE_SECTION_TITLE,
  globalStyleApplies,
  globalStyleComposeInstructions,
  globalStyleIsOptedOut,
  globalStyleStatusDescription,
  globalStyleStripOptOutMarkers,
} from "./global-style";

describe("GlobalStyle presentation policy", () => {
  it("uses Global style in public copy and never House style", () => {
    expect(GLOBAL_STYLE_SECTION_TITLE).toBe("Global style");
    expect(GLOBAL_STYLE_SECTION_TITLE.toLowerCase()).not.toContain("house");
    expect(GLOBAL_STYLE_SECTION_FOOTER.toLowerCase()).not.toContain("house");
    expect(GLOBAL_STYLE_SECTION_FOOTER).not.toContain("[house-style: off]");
  });

  it("applies by default when enabled in config", () => {
    const config = { houseStyle: { enabled: true, instructions: "Keep answers succinct." } };
    expect(globalStyleApplies(config, "Be helpful.")).toBe(true);
    expect(globalStyleStatusDescription(config, "Be helpful.")).toBe("Global style applies to this bot.");
  });

  it("does not apply when disabled in settings", () => {
    const config = { houseStyle: { enabled: false, instructions: "Keep answers succinct." } };
    expect(globalStyleApplies(config, "Be helpful.")).toBe(false);
    expect(globalStyleStatusDescription(config, "Be helpful.")).toBe("Global style is turned off in Settings.");
  });

  it("detects bot opt-out via marker", () => {
    const config = { houseStyle: { enabled: true, instructions: "Keep answers succinct." } };
    const withLegacy = "You are a pirate.\n[house-style: off]";
    expect(globalStyleIsOptedOut(withLegacy)).toBe(true);
    expect(globalStyleApplies(config, withLegacy)).toBe(false);
    expect(globalStyleStatusDescription(config, withLegacy)).toBe("Global style is turned off for this bot.");

    const withGlobal = "You are a pirate.\n[global-style: off]";
    expect(globalStyleIsOptedOut(withGlobal)).toBe(true);
    expect(globalStyleApplies(config, withGlobal)).toBe(false);
  });

  it("strips opt-out markers from user text cleanly", () => {
    expect(globalStyleStripOptOutMarkers("Friendly and direct.\n[house-style: off]")).toBe("Friendly and direct.");
    expect(globalStyleStripOptOutMarkers("Friendly and direct.\n[global-style: off]")).toBe("Friendly and direct.");
  });

  it("composes instructions with opt-out marker only when disabled", () => {
    expect(globalStyleComposeInstructions("Friendly and direct.", true)).toBe("Friendly and direct.");
    const disabled = globalStyleComposeInstructions("Friendly and direct.", false);
    expect(disabled).toBe("Friendly and direct.\n[house-style: off]");
    expect(globalStyleIsOptedOut(disabled)).toBe(true);
  });
});
