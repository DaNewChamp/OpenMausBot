import { describe, expect, it } from "vitest";

import {
  DESKTOP_DEMO_QUERY,
  desktopDemoFixture,
  isDesktopDemoMode,
} from "./desktop-demo";
import { conversationTitle } from "./model-suffix";
import { sanitizeProviderCatalog } from "./shell-status";

describe("desktop demo fixture", () => {
  it("detects the query flag without touching production data", () => {
    expect(isDesktopDemoMode(`?${DESKTOP_DEMO_QUERY}=1`)).toBe(true);
    expect(isDesktopDemoMode("")).toBe(false);
  });

  it("hydrates a three-column roster with chief, unreads, and no provider secrets", () => {
    const fixture = desktopDemoFixture();
    const chief = fixture.bots.find((bot) => bot.chiefOfStaff);
    expect(chief?.name).toBe("Chief Keef");
    expect(fixture.selectedId).toBe(chief?.id);
    expect(conversationTitle(chief!.name, chief!.modelSelection)).toBe("Chief Keef · S-M");
    expect(fixture.bots.filter((bot) => bot.unread).length).toBeGreaterThan(0);
    expect(fixture.routines.map((routine) => routine.name)).toContain("PM prediction scan");
    expect(fixture.config.profile?.name).toBe("Vincent Posival");
    expect(JSON.stringify(sanitizeProviderCatalog(fixture.instances))).not.toMatch(/key|token|secret/i);
    expect(JSON.stringify(fixture)).not.toMatch(/sk-|api[_-]?key/i);
  });
});
