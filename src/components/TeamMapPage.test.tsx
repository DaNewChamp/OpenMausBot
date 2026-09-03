import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TeamMapView, loadTeamMapSnapshot } from "./TeamMapPage";
import { Sidebar } from "./Sidebar";
import { StoreProvider, type Bot } from "@/state/store";
import {
  clearHubConnection,
  setHubApiBase,
  setHubDeviceToken,
} from "@/lib/web-client-session";
import type { TeamMapSnapshot } from "@/lib/team-map";

function botFixture(overrides: Partial<Bot> & Pick<Bot, "id" | "name">): Bot {
  return {
    threadId: `thread-${overrides.id}`,
    title: "Tester",
    description: "",
    notifications: false,
    color: "teal",
    unread: false,
    modelSelection: { instanceId: "inst-1", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

// Shaped exactly like the hub's GET /api/team-map payload.
const SNAPSHOT: TeamMapSnapshot = {
  collaborations: [{ groupId: "dm-atlas-rover", botIds: ["atlas", "rover"], lastAt: 1_700_000_000_000 }],
  queued: [{ sourceBotId: "atlas", targetBotId: "pilot", reason: "Draft launch notes" }],
  running: [{ sourceBotId: "rover", targetBotId: "atlas", threadId: "thread-9", groupId: "group-9" }],
};

const BOTS: Bot[] = [
  botFixture({ id: "atlas", name: "Atlas", title: "Chief of Staff", section: "Ops", chiefOfStaff: true, busy: true }),
  botFixture({ id: "rover", name: "Rover", section: "Ops", activity: "working" }),
  botFixture({ id: "ghost", name: "Ghost", section: "Ops", hidden: true }),
  botFixture({ id: "pilot", name: "Pilot", activity: "waiting-on-you" }),
];

function renderMap(bots: Bot[] = BOTS, snapshot: TeamMapSnapshot = SNAPSHOT) {
  return renderToStaticMarkup(
    createElement(TeamMapView, {
      bots,
      snapshot,
      onSelect: () => undefined,
      refreshing: false,
      error: null,
      onRefresh: () => undefined,
      onOpenContext: () => undefined,
    }),
  );
}

describe("TeamMapView", () => {
  it("renders the hierarchy from an /api/team-map fixture: chiefs above reports, hidden bots excluded", () => {
    const html = renderMap();
    expect(html).toContain("Ops");
    expect(html).toContain("General");
    expect(html).toContain("Atlas");
    expect(html).toContain("Rover");
    expect(html).toContain("Pilot");
    expect(html).not.toContain("Ghost");
    expect(html).toContain('aria-label="Chief of Staff"');
    expect(html).toContain("Draft launch notes");
  });

  it("shows live roster counts and bot⇄bot handoff edges, running ranked above queued", () => {
    const html = renderMap();
    expect(html).toContain("Working");
    expect(html).toContain("Waiting on you");
    expect(html).toContain(">Running</span>");
    expect(html).toContain(">Queued</span>");
    const running = html.indexOf("Running</span>");
    const queued = html.indexOf("Queued</span>");
    expect(running).toBeGreaterThan(-1);
    expect(queued).toBeGreaterThan(running);
  });

  it("renders the empty handoff state when the snapshot carries no edges", () => {
    const html = renderMap(BOTS, { collaborations: [], queued: [], running: [] });
    expect(html).toContain("No bot-to-bot handoffs yet");
    expect(html).not.toContain(">Running</span>");
  });
});

describe("team map on the web client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    clearHubConnection();
    delete (globalThis as { location?: unknown }).location;
    delete (globalThis as { window?: unknown }).window;
    globalThis.fetch = originalFetch;
  });

  it("fetches /api/team-map through the hub api with the paired device token", async () => {
    (globalThis as { location?: unknown }).location = new URL("https://vbot.posival.com/");
    setHubApiBase("https://hub.example");
    setHubDeviceToken("omb_" + "c".repeat(43));
    let requestedUrl = "";
    let authorization = "";
    const payload = JSON.stringify(SNAPSHOT);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const snapshot = await loadTeamMapSnapshot();

    expect(requestedUrl).toBe("https://hub.example/api/team-map");
    expect(authorization).toBe(`Bearer omb_${"c".repeat(43)}`);
    expect(snapshot).toEqual(SNAPSHOT);
  });

  it("exposes a Team map entry in the web sidebar header, absent on desktop chrome", () => {
    // The sidebar chrome reads `window.ogb` directly; in node, alias it.
    (globalThis as { window?: unknown }).window = globalThis;
    const web = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(Sidebar, { web: true, open: true, onClose: () => undefined })),
    );
    expect(web).toContain("data-web-team-map-entry");
    expect(web).toContain('aria-label="Team map"');

    const desktop = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: () => undefined })),
    );
    expect(desktop).not.toContain("data-web-team-map-entry");
  });
});
