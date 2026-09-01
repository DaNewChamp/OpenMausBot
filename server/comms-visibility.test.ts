import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HermesEngineError } from "./engines/contracts.ts";
import type { ModelSelection } from "./contracts.ts";
import { DATA_DIR } from "./config.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("comms-visibility Hermes peer gates", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("creates a DM channel for proven-unbound peers", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Alpha", section: "Work" }, { seedMessages: false });
    const target = store.createBot({ name: "Beta", section: "Work" }, { seedMessages: false });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), JSON.stringify({ version: 1, bindings: {} }), { mode: 0o600 });
    const channel = getOrCreateChannel(store, from, target);
    expect(channel.dm).toBe(true);
    expect(channel.memberIds.sort()).toEqual([from.id, target.id].sort());
  });

  it("reuses an existing DM without re-checking membership", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Alpha", section: "Work" }, { seedMessages: false });
    const target = store.createBot({ name: "Beta", section: "Work" }, { seedMessages: false });
    const first = getOrCreateChannel(store, from, target);
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    expect(getOrCreateChannel(store, from, target).id).toBe(first.id);
  });

  it("refuses to mint a DM when either peer is Hermes-bound", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Alpha", section: "Work" }, { seedMessages: false });
    const target = store.createBot({ name: "Beta", section: "Work" }, { seedMessages: false });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [target.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });
    expect(() => getOrCreateChannel(store, from, target)).toThrow(HermesEngineError);
    expect(() => getOrCreateChannel(store, from, target)).toThrow(/does not support groups/);
    expect(store.groups.filter((group) => group.dm)).toHaveLength(0);
  });

  it("refuses to mint a DM when binding state is unreadable", () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Alpha", section: "Work" }, { seedMessages: false });
    const target = store.createBot({ name: "Beta", section: "Work" }, { seedMessages: false });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    expect(() => getOrCreateChannel(store, from, target)).toThrow(HermesEngineError);
    expect(() => getOrCreateChannel(store, from, target)).toThrow(/invalid response/);
    expect(store.groups.filter((group) => group.dm)).toHaveLength(0);
  });
});
