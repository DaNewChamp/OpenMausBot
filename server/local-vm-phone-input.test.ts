import { describe, expect, it, vi } from "vitest";

import { executeLocalVmPhoneInput } from "./local-vm-phone-input.ts";

describe("local VM phone input", () => {
  it("rejects unknown actions and fields", async () => {
    const result = await executeLocalVmPhoneInput({ action: "bash" }, {
      runtime: "docker",
      containerName: "bot-vm",
      runner: vi.fn(),
    });
    expect(result).toEqual({ ok: false, status: 400, error: "action must be click, scroll, type, or key" });
  });

  it("requires coordinates for click", async () => {
    const result = await executeLocalVmPhoneInput({ action: "click" }, {
      runtime: "docker",
      containerName: "bot-vm",
      runner: vi.fn(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("x and y");
  });
});
