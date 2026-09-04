import { describe, expect, it } from "vitest";

import { computerStatusSummary } from "./computer-status";

describe("computer status summary", () => {
  it("distinguishes a ready cloud frame from a local VM", () => {
    expect(computerStatusSummary({ phase: "ready", cloudBackend: "vps" })).toMatchObject({
      title: "VPS computer ready",
      tone: "positive",
    });
    expect(computerStatusSummary({ phase: "vm" })).toMatchObject({
      title: "Linux VM ready",
      detail: expect.stringContaining("Take control"),
    });
    expect(computerStatusSummary({ phase: "vm", shared: false })).toMatchObject({
      title: "Linux VM ready",
      detail: expect.stringContaining("private browser"),
    });
  });

  it("does not promise computer control for the reconstructed engine", () => {
    expect(computerStatusSummary({ phase: "ready", reconstructed: true })).toEqual({
      title: "Computer unavailable",
      detail: "This engine provides chat and history only; computer control stays off.",
      tone: "warning",
    });
  });

  it("keeps failures actionable without leaking backend details", () => {
    const summary = computerStatusSummary({ phase: "error", error: "Could not reach the computer" });
    expect(summary).toMatchObject({ title: "Computer needs attention", tone: "danger" });
    expect(summary.detail).toBe("Could not reach the computer");
    expect(summary.detail).not.toMatch(/token|password|127\.0\.0\.1|omb_viewer/i);
  });
});
