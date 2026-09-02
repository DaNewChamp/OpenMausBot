import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  loadHermesBridgeBindings,
  removeHermesBridgeBinding,
  setHermesBridgeBinding,
} from "./bridge-hermes-bindings.ts";

function resetBindingsData(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const path = join(DATA_DIR, "hermes-bridge-bindings.json");
  if (existsSync(path)) rmSync(path);
}

describe("Hermes bridge bindings", () => {
  beforeEach(() => {
    resetBindingsData();
  });

  it("stores only bridge id and profile slug", () => {
    const saved = setHermesBridgeBinding("bot-1", {
      bridgeId: "bridge-abc",
      profile: "default",
      bindingVersion: 1,
    });
    expect(saved.state).toBe("available");
    const loaded = loadHermesBridgeBindings();
    expect(loaded.state).toBe("available");
    if (loaded.state !== "available") return;
    expect(loaded.value.get("bot-1")).toEqual({
      bridgeId: "bridge-abc",
      profile: "default",
      bindingVersion: 1,
    });
    expect(JSON.stringify(loaded.value)).not.toMatch(/HERMES_HOME|session|token|path/i);
  });

  it("fails closed on malformed sidecar bytes", () => {
    writeFileSync(join(DATA_DIR, "hermes-bridge-bindings.json"), "{not-json", { mode: 0o600 });
    expect(loadHermesBridgeBindings()).toMatchObject({ state: "unavailable" });
    resetBindingsData();
  });

  it("removes bindings without touching unrelated bots", () => {
    setHermesBridgeBinding("bot-1", { bridgeId: "bridge-a", profile: "default", bindingVersion: 1 });
    setHermesBridgeBinding("bot-2", { bridgeId: "bridge-b", profile: "work", bindingVersion: 1 });
    removeHermesBridgeBinding("bot-1");
    const loaded = loadHermesBridgeBindings();
    expect(loaded.state).toBe("available");
    if (loaded.state !== "available") return;
    expect(loaded.value.has("bot-1")).toBe(false);
    expect(loaded.value.get("bot-2")).toMatchObject({ bridgeId: "bridge-b", profile: "work" });
  });
});
