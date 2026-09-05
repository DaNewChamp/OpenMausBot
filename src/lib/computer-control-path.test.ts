import { describe, expect, it } from "vitest";
import { computerControlPath } from "./computer-control-path";

describe("computer control capability routing", () => {
  it("uses only a local-VM-scoped route for paired browsers", () => {
    expect(computerControlPath("bot-one", "vm", true)).toBe("/api/bots/bot-one/local-computer/control");
    for (const mode of ["local", "cloud", "off", undefined]) expect(computerControlPath("bot-one", mode, true)).toBeNull();
  });
  it("preserves native desktop control", () => {
    for (const mode of ["vm", "local", "cloud", "off"]) expect(computerControlPath("bot-one", mode, false)).toBe("/api/bots/bot-one/computer/control");
  });
});
