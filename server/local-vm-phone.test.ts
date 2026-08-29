import { describe, expect, it } from "vitest";

import type { ContainerComputerStatus } from "./container-computer.ts";
import { projectLocalVmStatus } from "./local-vm-phone.ts";

const status = (overrides: Partial<ContainerComputerStatus> = {}): ContainerComputerStatus => ({
  platform: "darwin",
  runtime: "docker",
  available: ["docker"],
  daemonUp: true,
  image: true,
  imageMatches: true,
  managed: true,
  container: "running",
  network: "loopback",
  security: "hardened",
  persistence: "durable",
  desktopReady: true,
  desktop_error: null,
  create_supported: true,
  ready: true,
  problem: null,
  image_ref: "secret-image-ref",
  image_id: "secret-image-id",
  base_image_ref: "secret-base-ref",
  driver_version: "0.20.0",
  container_name: "secret-container",
  target_key: "secret-target",
  workspace_path: "/Users/vincent/private/workspace",
  workspace_guest_path: "/home/cua/workspace",
  viewer_port: 6080,
  viewer_url: "http://127.0.0.1:6080/vnc.html#password=secret",
  ...overrides,
});

describe("phone-safe Local VM projection", () => {
  it("allowlists status and omits host and viewer details", () => {
    const projected = projectLocalVmStatus(status(), { mode: "per-bot", maxInstances: 2 });
    expect(projected).toEqual({
      mode: "per-bot",
      max_instances: 2,
      state: "ready",
      container: "running",
      daemon_up: true,
      image_ready: true,
      desktop_ready: true,
      ready: true,
      create_supported: true,
      busy: false,
      can_create: false,
      can_stop: true,
      can_recreate: true,
      problem: null,
    });
    const wire = JSON.stringify(projected);
    for (const secret of ["secret-image", "secret-container", "/Users/vincent", "/home/cua", "127.0.0.1", "6080", "password"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("allows shared-mode lifecycle actions when the desktop is idle", () => {
    const sharedStopped = projectLocalVmStatus(status({ container: "stopped", ready: false }), { mode: "shared", maxInstances: 2 });
    expect(sharedStopped.can_create).toBe(false);
    expect(sharedStopped.can_stop).toBe(false);
    expect(sharedStopped.can_recreate).toBe(true);
    expect(sharedStopped.problem).toBe("Recreate the Local VM.");

    const sharedMissing = projectLocalVmStatus(status({ container: "missing", ready: false }), { mode: "shared", maxInstances: 2 });
    expect(sharedMissing.can_create).toBe(true);
    expect(sharedMissing.can_recreate).toBe(false);

    const sharedRunning = projectLocalVmStatus(status(), { mode: "shared", maxInstances: 2 });
    expect(sharedRunning.can_stop).toBe(true);
    expect(sharedRunning.can_recreate).toBe(true);
  });

  it("denies lifecycle actions while a lease is busy", () => {
    const busy = projectLocalVmStatus(status(), { mode: "per-bot", maxInstances: 2, busy: true });
    expect(busy.busy).toBe(true);
    expect(busy.can_stop).toBe(false);
    expect(busy.can_recreate).toBe(false);
  });

  it("uses generic problems when desktop output contains host details", () => {
    const projected = projectLocalVmStatus(
      status({ desktop_error: "/Users/vincent/.openmausbot/private command --token abc" }),
      { mode: "per-bot", maxInstances: 2 },
    );
    expect(projected.problem).toBe("The Local VM desktop is unavailable.");
    expect(JSON.stringify(projected)).not.toContain("/Users/");
    expect(JSON.stringify(projected)).not.toContain("token");
  });

  it("only reports create when the exact hardened image is ready", () => {
    const missing = projectLocalVmStatus(
      status({ container: "missing", ready: false, imageMatches: false }),
      { mode: "per-bot", maxInstances: 2 },
    );
    expect(missing.state).toBe("missing");
    expect(missing.can_create).toBe(false);
    expect(missing.can_recreate).toBe(false);
  });
});
