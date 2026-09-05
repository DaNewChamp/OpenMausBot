import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerControlButton } from "./ComputerControlButton";

describe("computer control affordance", () => {
  it("shows an assignment action, never forbidden takeover, for a view-only bot", () => {
    const html = renderToStaticMarkup(<ComputerControlButton canControl={false} pending={false} onTake={vi.fn()} onConfigure={vi.fn()} />);
    expect(html).toContain("View only");
    expect(html).toContain("Assign Local VM to this bot in Settings to take control");
    expect(html).not.toContain("Take control");
  });
  it("offers takeover only when the route is available", () => {
    const html = renderToStaticMarkup(<ComputerControlButton canControl pending={false} onTake={vi.fn()} onConfigure={vi.fn()} />);
    expect(html).toContain("Take control");
    expect(html).not.toContain("View only");
  });
  it("disables repeated actions while a request is pending", () => {
    const html = renderToStaticMarkup(<ComputerControlButton canControl pending onTake={vi.fn()} onConfigure={vi.fn()} />);
    expect(html).toContain('disabled=""');
  });
});
