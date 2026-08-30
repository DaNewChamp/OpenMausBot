import { describe, expect, it } from "vitest";

import { conversationTitle, effortAbbrev, modelSizeToken, modelSuffix } from "./model-suffix";

describe("model suffix", () => {
  it("maps size and effort into the compact name suffix", () => {
    expect(modelSizeToken("super")).toBe("S");
    expect(modelSizeToken("haiku")).toBe("S");
    expect(modelSizeToken("grok-4")).toBe("L");
    expect(effortAbbrev("medium")).toBe("M");
    expect(effortAbbrev("xhigh")).toBe("XH");
    expect(modelSuffix({ model: "super", effort: "medium" })).toBe("S-M");
    expect(modelSuffix({ model: "grok-4", effort: "xhigh" })).toBe("L-XH");
    expect(conversationTitle("Chief Keef", { model: "super", effort: "medium" })).toBe("Chief Keef · S-M");
  });

  it("omits effort when the engine did not send one", () => {
    expect(modelSuffix({ model: "sonnet" })).toBe("M");
    expect(effortAbbrev("none")).toBe("");
    expect(effortAbbrev("not-an-effort")).toBe("");
  });
});
