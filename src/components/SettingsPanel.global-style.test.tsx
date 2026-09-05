import { describe, expect, it } from "vitest";
import {
  globalStyleApplies,
  globalStyleComposeInstructions,
  globalStyleIsOptedOut,
  globalStyleStatusDescription,
  globalStyleStripOptOutMarkers,
} from "@/lib/global-style";

describe("Bot instructions global style integration", () => {
  it("hides raw opt-out markers from user textarea and reapplies cleanly", () => {
    const rawWithMarker = "You are a specialist.\n[house-style: off]";
    expect(globalStyleIsOptedOut(rawWithMarker)).toBe(true);
    expect(globalStyleApplies({ houseStyle: { enabled: true } }, rawWithMarker)).toBe(false);
    expect(globalStyleStatusDescription({ houseStyle: { enabled: true } }, rawWithMarker)).toBe(
      "Global style is turned off for this bot.",
    );

    const visibleText = globalStyleStripOptOutMarkers(rawWithMarker);
    expect(visibleText).toBe("You are a specialist.");
    expect(visibleText).not.toContain("[house-style: off]");

    // User edits visible text while keeping opt-out
    const editedText = "You are an expert specialist.";
    const composed = globalStyleComposeInstructions(editedText, false);
    expect(composed).toBe("You are an expert specialist.\n[house-style: off]");
    expect(globalStyleIsOptedOut(composed)).toBe(true);

    // User turns global style back on
    const enabled = globalStyleComposeInstructions(composed, true);
    expect(enabled).toBe("You are an expert specialist.");
    expect(globalStyleIsOptedOut(enabled)).toBe(false);
    expect(globalStyleApplies({ houseStyle: { enabled: true } }, enabled)).toBe(true);
  });
});
