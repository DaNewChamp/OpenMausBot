import { describe, expect, it } from "vitest";

import { computerStatusSummary } from "./computer-status";

describe("computer status summary", () => {
  it("distinguishes a ready cloud frame from a local VM", () => {
    expect(computerStatusSummary({ phase: "ready", cloudBackend: "vps" })).toMatchObject({
      title: "VPS computer ready",
      tone: "positive",
    });
    expect(computerStatusSummary({ phase: "vm", hostName: "VincentPC", hostOnline: true })).toMatchObject({
      title: "Shared browser ready",
      detail: expect.stringMatching(/Chromium container/),
      tone: "positive",
    });
    expect(computerStatusSummary({
      phase: "vm",
      shared: false,
      hostName: "VincentPC",
      hostOnline: true,
    })).toMatchObject({
      title: "Own browser ready",
      detail: expect.stringMatching(/this bot/i),
    });
  });

  it("does not look ready when the selected fleet host is offline", () => {
    const summary = computerStatusSummary({
      phase: "vm",
      hostName: "VincentPC",
      hostOnline: false,
      shared: true,
    });
    expect(summary.tone).toBe("warning");
    expect(summary.title).toMatch(/VincentPC is offline/);
    expect(summary.detail).not.toMatch(/ready/i);
    expect(summary.detail).toMatch(/container/);
  });

  it("sends Local VM setup to Settings instead of Deploy from the Computer pane", () => {
    const summary = computerStatusSummary({ phase: "vm-unavailable" });
    expect(summary.title).toBe("Browser not ready");
    expect(summary.detail).toMatch(/Settings/);
    expect(summary.detail).not.toMatch(/Deploy/i);
    expect(summary.tone).toBe("warning");
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
