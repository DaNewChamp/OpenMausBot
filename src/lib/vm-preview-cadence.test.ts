import { describe, expect, it } from "vitest";
import { vmPreviewCadenceMs } from "./vm-preview-cadence";

describe("vmPreviewCadenceMs", () => {
  it("uses a live cadence while the person is driving the Local VM", () => {
    expect(vmPreviewCadenceMs({ humanHeld: true, botBusy: true })).toBeLessThanOrEqual(750);
    expect(vmPreviewCadenceMs({ humanHeld: true, botBusy: false })).toBeLessThanOrEqual(750);
  });

  it("keeps the existing low-cost cadence when the bot owns the computer", () => {
    expect(vmPreviewCadenceMs({ humanHeld: false, botBusy: true })).toBe(3000);
    expect(vmPreviewCadenceMs({ humanHeld: false, botBusy: false })).toBe(30_000);
  });
});
