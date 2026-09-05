import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BotComputerChoice } from "./BotComputerChoice";

describe("Bot computer choice options", () => {
  it("renders Auto, Specific computer, and Isolated VM without execution-bridge copy", () => {
    const html = renderToStaticMarkup(
      <BotComputerChoice
        computer="vm"
        computerHostId="mini"
        hosts={[
          { id: "mini", name: "Mac mini", online: true, capabilities: ["shell", "local-vm"] },
        ]}
        onChange={vi.fn()}
      />
    );

    expect(html).toContain("Auto");
    expect(html).toContain("Specific computer");
    expect(html).toContain("Isolated VM");
    expect(html).not.toMatch(/execution bridge/i);
    expect(html).not.toMatch(/bridge/i);
  });

  it("exposes specific computer picker when Specific computer is selected", () => {
    const html = renderToStaticMarkup(
      <BotComputerChoice
        computer="local"
        computerHostId="mini"
        hosts={[
          { id: "mini", name: "Mac mini", online: true, capabilities: ["shell"] },
          { id: "win", name: "Windows PC", online: false, capabilities: ["shell"] },
        ]}
        onChange={vi.fn()}
      />
    );

    expect(html).toContain("Mac mini");
    expect(html).toContain("Windows PC (offline)");
    expect(html).not.toMatch(/bridge/i);
  });
});
