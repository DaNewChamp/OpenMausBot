import { describe, expect, it } from "vitest";
import {
  AVAILABLE_COMPUTERS_SECTION_FOOTER,
  AVAILABLE_COMPUTERS_SECTION_TITLE,
  HUB_SECTION_TITLE,
  computerSummary,
  connectedComputerCount,
  fleetHostStatusText,
  BOT_COMPUTER_TARGET_OPTIONS,
} from "./fleet-presentation";

describe("fleet presentation terminology", () => {
  it("formats hub and connected computers summary matching iOS", () => {
    expect(computerSummary(1, 2)).toBe("1 hub · 2 connected computers");
    expect(computerSummary(1, 1)).toBe("1 hub · 1 connected computer");
    expect(computerSummary(1, 0)).toBe("1 hub · 0 connected computers");
    expect(computerSummary(0, 0)).toBe("0 hubs · 0 connected computers");
    expect(computerSummary(2, 3)).toBe("2 hubs · 3 connected computers");
  });

  it("exposes canonical Hub and Available computers titles and footer", () => {
    expect(HUB_SECTION_TITLE).toBe("Hub");
    expect(AVAILABLE_COMPUTERS_SECTION_TITLE).toBe("Available computers");
    expect(AVAILABLE_COMPUTERS_SECTION_FOOTER).toBe(
      "Computers connected to this hub run tasks for your bots. They are managed through the hub rather than paired directly with your phone.",
    );
    expect(AVAILABLE_COMPUTERS_SECTION_TITLE).not.toMatch(/bridge/i);
    expect(AVAILABLE_COMPUTERS_SECTION_FOOTER).not.toMatch(/execution bridge/i);
  });

  it("reports concise online/offline state", () => {
    expect(fleetHostStatusText({ online: true })).toBe("Online");
    expect(fleetHostStatusText({ online: false })).toBe("Offline");
    expect(fleetHostStatusText({ online: true, stale: true })).toBe("Offline");
  });

  it("counts connected computers excluding offline and stale entries", () => {
    const hosts = [
      { id: "h1", name: "Mac mini", online: true },
      { id: "h2", name: "Windows PC", online: true },
      { id: "h3", name: "Linux Server", online: false },
    ];
    expect(connectedComputerCount(hosts)).toBe(2);
  });

  it("defines bot computer choices: Auto, Specific computer, Isolated VM", () => {
    const keys = BOT_COMPUTER_TARGET_OPTIONS.map((o) => o.id);
    expect(keys).toContain("auto");
    expect(keys).toContain("specific");
    expect(keys).toContain("vm");

    for (const opt of BOT_COMPUTER_TARGET_OPTIONS) {
      expect(opt.label).not.toMatch(/bridge/i);
      expect(opt.description).not.toMatch(/execution bridge/i);
    }
  });
});
