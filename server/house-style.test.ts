import { describe, expect, it } from "vitest";

import { DEFAULT_HOUSE_STYLE_INSTRUCTIONS, type AppConfig } from "./config.ts";
import {
  GLOBAL_STYLE_OPT_OUT_MARKER,
  HOUSE_STYLE_OPT_OUT_MARKER,
  globalStylePreamble,
  houseStylePreamble,
} from "./house-style.ts";

function cfg(patch?: AppConfig["houseStyle"]): AppConfig {
  return { houseStyle: patch };
}

describe("house style preamble", () => {
  it("applies the default text to a bot with no own instructions", () => {
    const block = houseStylePreamble(cfg(), "");
    expect(block).toContain(DEFAULT_HOUSE_STYLE_INSTRUCTIONS);
    expect(block).toContain("--- House style");
    expect(block).toContain("--- end house style ---");
  });

  it("suppresses the block when the bot's own instructions carry the opt-out marker", () => {
    const own = `Be extremely formal at all times.\n${HOUSE_STYLE_OPT_OUT_MARKER}\nSign every reply with a wax seal.`;
    expect(houseStylePreamble(cfg(), own)).toBe("");
    expect(houseStylePreamble(cfg(), HOUSE_STYLE_OPT_OUT_MARKER)).toBe("");
    expect(houseStylePreamble(cfg(), `  ${HOUSE_STYLE_OPT_OUT_MARKER}  `)).toBe("");
  });

  it("keeps the block when the marker only appears mid-line or is misspelled", () => {
    expect(houseStylePreamble(cfg(), `never write ${HOUSE_STYLE_OPT_OUT_MARKER} anywhere`)).toContain(
      DEFAULT_HOUSE_STYLE_INSTRUCTIONS,
    );
  });

  it("uses the hub owner's custom text when set", () => {
    const block = houseStylePreamble(cfg({ instructions: "Always rhyme." }), "About text");
    expect(block).toContain("Always rhyme.");
    expect(block).not.toContain(DEFAULT_HOUSE_STYLE_INSTRUCTIONS);
  });

  it("falls back to the default when the saved custom text is blank", () => {
    expect(houseStylePreamble(cfg({ instructions: "   " }), "")).toContain(DEFAULT_HOUSE_STYLE_INSTRUCTIONS);
  });

  it("suppresses the block when the toggle is off, even with custom text", () => {
    expect(houseStylePreamble(cfg({ enabled: false, instructions: "Always rhyme." }), "")).toBe("");
  });

  it("suppresses the block when the bot's own instructions carry global-style opt-out markers", () => {
    expect(houseStylePreamble(cfg(), GLOBAL_STYLE_OPT_OUT_MARKER)).toBe("");
    expect(houseStylePreamble(cfg(), "  [global-style: off]  ")).toBe("");
    expect(houseStylePreamble(cfg(), "global style: off")).toBe("");
    expect(houseStylePreamble(cfg(), "Global Style: Off")).toBe("");
  });

  it("never duplicates prompt blocks if preamble was already applied", () => {
    const existingPreamble = houseStylePreamble(cfg(), "");
    expect(existingPreamble).toBeTruthy();
    const secondCall = houseStylePreamble(cfg(), `${existingPreamble}\nBot instructions`);
    expect(secondCall).toBe("");
  });

  it("exposes globalStylePreamble alias that behaves identically", () => {
    expect(globalStylePreamble(cfg(), "")).toBe(houseStylePreamble(cfg(), ""));
    expect(globalStylePreamble(cfg({ enabled: false }), "")).toBe("");
    expect(globalStylePreamble(cfg(), GLOBAL_STYLE_OPT_OUT_MARKER)).toBe("");
  });
});
