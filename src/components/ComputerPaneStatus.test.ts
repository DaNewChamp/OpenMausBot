import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { computerStatusSummary } from "@/lib/computer-status";
import {
  COMPUTER_PANE_MANAGE_LABEL,
  COMPUTER_PANE_SETUP_LABEL,
  ComputerPaneStatus,
  computerPaneContext,
  computerPaneLifecycleNav,
  computerPaneLooksReady,
  localVmSettingsAction,
} from "./ComputerPaneStatus";

const windows = {
  id: "6b9c61f5-3517-4a59-9abe-25f3af311fef",
  name: "VincentPC",
  online: true,
  capabilities: ["shell", "local-vm"],
};
const miniOffline = {
  id: "d029c24b-2b35-44c4-80a6-6148e350cad9",
  name: "Vincents-Mac-mini.local",
  online: false,
  capabilities: ["shell", "local-vm", "hermes"],
};

describe("Computer pane lifecycle ownership", () => {
  it("opens App Settings on the Local VM section, not bot settings or a silent config write", () => {
    expect(localVmSettingsAction()).toEqual({
      type: "toggleAppSettings",
      open: true,
      section: "computer",
    });
    expect(localVmSettingsAction()).not.toMatchObject({ type: "toggleSettings" });
    expect(JSON.stringify(localVmSettingsAction())).not.toMatch(/localVm|hostId|mode|maxInstances/);
  });

  it("uses Set up in Settings before a container exists and Manage in Settings once it does", () => {
    expect(computerPaneLifecycleNav({ container: "missing" })).toEqual({
      kind: "setup",
      label: COMPUTER_PANE_SETUP_LABEL,
      action: localVmSettingsAction(),
    });
    expect(computerPaneLifecycleNav({})).toMatchObject({ kind: "setup", label: COMPUTER_PANE_SETUP_LABEL });
    expect(computerPaneLifecycleNav({ container: "running" })).toEqual({
      kind: "manage",
      label: COMPUTER_PANE_MANAGE_LABEL,
      action: localVmSettingsAction(),
    });
    expect(computerPaneLifecycleNav({ container: "stopped" })).toMatchObject({
      kind: "manage",
      label: COMPUTER_PANE_MANAGE_LABEL,
    });
    expect(computerPaneLifecycleNav({ ready: true, container: "missing" })).toMatchObject({
      kind: "manage",
      label: COMPUTER_PANE_MANAGE_LABEL,
    });
  });

  it("never treats Deploy or Remove as Computer pane actions", () => {
    for (const nav of [
      computerPaneLifecycleNav({ container: "missing" }),
      computerPaneLifecycleNav({ container: "running" }),
      computerPaneLifecycleNav({ container: "stopped", ready: true }),
    ]) {
      expect(nav.label).not.toMatch(/deploy|remove|delete|recreate/i);
      expect(nav.kind).toMatch(/^(setup|manage)$/);
      expect(nav.action.section).toBe("computer");
    }
  });
});

describe("Computer pane host and isolation context", () => {
  it("never looks ready when the selected host is offline, even if status says ready", () => {
    expect(computerPaneLooksReady({ statusReady: true, hostOnline: false })).toBe(false);
    expect(computerPaneLooksReady({ statusReady: true, hostOnline: true })).toBe(true);
    expect(computerPaneLooksReady({ statusReady: false, hostOnline: true })).toBe(false);
    expect(computerPaneLooksReady({ statusReady: true })).toBe(true);
  });

  it("shows the real selected machine and does not invent online or a Windows label", () => {
    const online = computerPaneContext({ host: windows, isolation: "shared" });
    expect(online.hostName).toBe("VincentPC");
    expect(online.hostState).toBe("online");
    expect(online.compactLine).toBe("VincentPC · online · Shared browser");
    expect(online.compactLine).not.toMatch(/Windows/i);

    const offline = computerPaneContext({ host: miniOffline, isolation: "shared" });
    expect(offline.hostState).toBe("offline");
    expect(offline.compactLine).toBe("Vincents-Mac-mini.local · offline · Shared browser");
    expect(offline.compactLine).not.toMatch(/\bonline\b/);

    const none = computerPaneContext({ host: null, isolation: null });
    expect(none.hostState).toBe("unselected");
    expect(none.compactLine).toBe("No machine selected");
    expect(none.compactLine).not.toMatch(/\bonline\b/);
  });

  it("explains shared vs own browser as a container, not a hardware VM", () => {
    const shared = computerPaneContext({ host: windows, isolation: "shared" });
    expect(shared.isolationKind).toBe("shared");
    expect(shared.isolationLabel).toBe("Shared browser");
    expect(shared.isolationDetail).toMatch(/Chromium container/i);
    expect(shared.isolationDetail).toMatch(/take turns/i);
    expect(shared.isolationDetail).not.toMatch(/hardware VM|independent VM|full VM/i);

    const own = computerPaneContext({ host: windows, isolation: "per-bot" });
    expect(own.isolationKind).toBe("own");
    expect(own.isolationLabel).toBe("Own browser");
    expect(own.compactLine).toContain("Own browser");
    expect(own.isolationDetail).toMatch(/this bot/i);
    expect(own.isolationDetail).toMatch(/container/i);
    expect(own.isolationDetail).not.toMatch(/hardware VM|independent hardware/i);
  });
});

describe("ComputerPaneStatus", () => {
  const render = (opts: {
    host?: typeof windows | typeof miniOffline | null;
    isolation?: "shared" | "per-bot" | null;
    phase?: "vm" | "vm-unavailable" | "checking";
    container?: "running" | "stopped" | "missing";
    ready?: boolean;
  }) => {
    const host = opts.host === undefined ? windows : opts.host;
    const isolation = opts.isolation === undefined ? "shared" : opts.isolation;
    const context = computerPaneContext({ host, isolation });
    const looksReady = computerPaneLooksReady({
      statusReady: opts.ready ?? opts.phase === "vm",
      hostOnline: host?.online,
    });
    const phase = looksReady ? "vm" : (opts.phase ?? "vm-unavailable");
    const summary = computerStatusSummary({
      phase,
      shared: isolation !== "per-bot",
      hostName: context.hostName,
      hostOnline: host?.online,
    });
    const lifecycle = computerPaneLifecycleNav({
      container: opts.container ?? (looksReady ? "running" : "missing"),
      ready: looksReady,
    });
    return renderToStaticMarkup(createElement(ComputerPaneStatus, {
      context,
      summary,
      lifecycle,
      onOpenSettings: vi.fn(),
    }));
  };

  it("navigates with Set up in Settings and keeps lifecycle out of the pane", () => {
    const html = render({ phase: "vm-unavailable", container: "missing", ready: false });
    expect(html).toContain(COMPUTER_PANE_SETUP_LABEL);
    expect(html).toContain('data-lifecycle="setup"');
    expect(html).toContain("type=\"button\"");
    expect(html).not.toMatch(/>\s*Deploy\s*</);
    expect(html).not.toMatch(/Delete this bot's VM|Remove|recreate/i);
    expect(html).not.toMatch(/<select/i);
  });

  it("keeps Manage in Settings once a container exists, still without Deploy/Remove", () => {
    const html = render({ phase: "vm", container: "running", ready: true });
    expect(html).toContain(COMPUTER_PANE_MANAGE_LABEL);
    expect(html).toContain('data-lifecycle="manage"');
    expect(html).toContain("VincentPC · online · Shared browser");
    expect(html).not.toMatch(/>\s*Deploy\s*</);
    expect(html).not.toMatch(/Delete this bot's VM/i);
  });

  it("never paints an offline selected host as ready", () => {
    const html = render({
      host: miniOffline,
      phase: "vm",
      container: "running",
      ready: true,
    });
    expect(html).toContain("Vincents-Mac-mini.local · offline · Shared browser");
    expect(html).toContain('data-host-state="offline"');
    expect(html).toContain('data-tone="warning"');
    expect(html).not.toContain('data-tone="positive"');
    expect(html).not.toMatch(/ready/i);
    expect(html).toContain(COMPUTER_PANE_MANAGE_LABEL);
  });

  it("keeps the compact status line readable in the empty unselected state", () => {
    const html = render({ host: null, isolation: null, phase: "vm-unavailable", ready: false });
    expect(html).toContain("No machine selected");
    expect(html).toContain(COMPUTER_PANE_SETUP_LABEL);
    expect(html).toContain('data-host-state="unselected"');
    expect(html).not.toMatch(/\bonline\b/);
  });
});
