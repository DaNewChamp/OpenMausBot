import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  paired: false,
  state: {
    selectedId: "second",
    bots: [{ id: "first", name: "First bot", busy: false }, { id: "second", name: "Selected bot", busy: false }],
    config: { localVm: { mode: "per-bot", maxInstances: 2, hostId: "fixture-host" } },
  },
}));
vi.mock("@/lib/web-client-mode", () => ({ isWebClientMode: () => fixture.paired }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }) }));
vi.mock("./ComputerHostPicker", () => ({
  FleetVmLocationPicker: () => null,
  useFleetVmLocation: () => ({ hosts: [], hostId: "fixture-host", selectedId: "fixture-host", selected: { name: "Fixture host", online: true }, blockReason: null, save: vi.fn() }),
}));
import { LocalComputerSection } from "./LocalComputerSection";

describe("Local VM Settings actual view", () => {
  beforeEach(() => { fixture.state.selectedId = "second"; fixture.paired = false; });
  it("opens on the selected bot's private workspace, not the first bot", () => {
    const html = renderToStaticMarkup(<LocalComputerSection />);
    expect(html).toContain('aria-label="Bot workspace"');
    expect(html).toMatch(/<option value="second" selected="">Selected bot<\/option>/);
    expect(html).not.toMatch(/<option value="first" selected/);
  });
  it("requires an explicit bot from a room", () => {
    fixture.state.selectedId = "room";
    const html = renderToStaticMarkup(<LocalComputerSection />);
    expect(html).toMatch(/<option value="" selected="">Choose a bot<\/option>/);
    expect(html).toContain("Choose a bot above to manage its private browser.");
  });
  it("keeps the paired web UI on the existing companion capability surface", () => {
    fixture.paired = true;
    const html = renderToStaticMarkup(<LocalComputerSection />);
    expect(html).toContain("Host-managed settings");
    expect(html).toContain("This paired web client does not expose");
    expect(html).not.toContain("Save limits");
    expect(html).not.toContain("Delete shared browser");
    expect(html).toMatch(/<option value="second" selected="">Selected bot<\/option>/);
  });
  it("does not offer deletion while container state is still unknown", () => {
    const html = renderToStaticMarkup(<LocalComputerSection />);
    expect(html).not.toMatch(/Delete this bot&#x27;s browser|Delete shared browser|Delete legacy shared VM/);
    expect(html).not.toContain("Create a private desktop from each bot&#x27;s Computer panel");
  });
});
