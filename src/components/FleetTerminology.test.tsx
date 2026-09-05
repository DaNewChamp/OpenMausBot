import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FleetPresentationCard } from "./FleetPresentationCard";

describe("fleet and computer UI terminology", () => {
  it("renders Hub and Available computers with concise online/offline badges", () => {
    const html = renderToStaticMarkup(
      <FleetPresentationCard
        hubName="Vincent's Mac Studio"
        hosts={[
          { id: "mini", name: "Mac mini", online: true, capabilities: ["shell", "local-vm"] },
          { id: "win", name: "Gaming PC", online: false, capabilities: ["shell"] },
        ]}
      />
    );

    expect(html).toContain("Hub");
    expect(html).toContain("Vincent&#x27;s Mac Studio");
    expect(html).toContain("1 hub · 1 connected computer");
    expect(html).toContain("Available computers");
    expect(html).toContain("Computers connected to this hub run tasks for your bots.");
    expect(html).toContain("Mac mini");
    expect(html).toContain("Online");
    expect(html).toContain("Gaming PC");
    expect(html).toContain("Offline");
    // Banning normal Execution bridge copy
    expect(html).not.toMatch(/execution bridge/i);
    expect(html).not.toMatch(/bridge/i);
  });

  it("handles zero connected computers gracefully", () => {
    const html = renderToStaticMarkup(
      <FleetPresentationCard
        hubName="Primary Hub"
        hosts={[]}
      />
    );

    expect(html).toContain("1 hub · 0 connected computers");
    expect(html).toContain("No computers connected to this hub yet.");
    expect(html).not.toMatch(/execution bridge/i);
  });
});
