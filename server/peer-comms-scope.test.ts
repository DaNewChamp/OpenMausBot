import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
import {
  canReachPeerBot,
  isTrustedHermesChief,
  visiblePeerBots,
} from "./peer-comms-scope.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

const hermesBinding = (bridgeId = "bridge-mini") => ({
  kind: "hermes" as const,
  placement: { kind: "bridge" as const, bridgeId, profile: "default" },
  bindingVersion: 2 as const,
});

describe("trusted Hermes chief peer comms scope", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("lets a trusted Hermes chief list and message Desk Docs in another section", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Hermes Chief" }, { seedMessages: false });
    const generalPeer = store.createBot({ name: "General Helper" }, { seedMessages: false });
    const deskDocs = store.createBot({ name: "Desk Docs", section: "Desk" }, { seedMessages: false });
    const hidden = store.createBot({ name: "Hidden Desk", section: "Desk" }, { seedMessages: false });
    store.patchBot(hidden.id, { hidden: true });
    store.patchBot(chief.id, { runtimeBinding: hermesBinding() });
    store.setChiefOfStaff(chief.id);

    expect(isTrustedHermesChief(store.bot(chief.id)!)).toBe(true);
    expect(canReachPeerBot(store.bot(chief.id)!, store.bot(deskDocs.id)!)).toBe(true);
    expect(visiblePeerBots(store, store.bot(chief.id)!).map((bot) => bot.name).sort()).toEqual([
      "Desk Docs",
      "General Helper",
    ]);
    expect(visiblePeerBots(store, store.bot(chief.id)!).some((bot) => bot.id === hidden.id)).toBe(false);
    expect(visiblePeerBots(store, store.bot(chief.id)!).some((bot) => bot.id === chief.id)).toBe(false);
    expect(visiblePeerBots(store, store.bot(generalPeer.id)!).map((bot) => bot.name)).toEqual(["Hermes Chief"]);
  });

  it("keeps ordinary V Bot bots and non-chief Hermes bots section-scoped", () => {
    const store = new Store(selection);
    const providerChief = store.createBot({ name: "Provider Chief" }, { seedMessages: false });
    const hermesSpecialist = store.createBot({ name: "Hermes Specialist" }, { seedMessages: false });
    const deskDocs = store.createBot({ name: "Desk Docs", section: "Desk" }, { seedMessages: false });
    store.setChiefOfStaff(providerChief.id);
    store.patchBot(hermesSpecialist.id, { runtimeBinding: hermesBinding() });

    expect(isTrustedHermesChief(store.bot(providerChief.id)!)).toBe(false);
    expect(isTrustedHermesChief(store.bot(hermesSpecialist.id)!)).toBe(false);
    expect(canReachPeerBot(store.bot(providerChief.id)!, store.bot(deskDocs.id)!)).toBe(false);
    expect(canReachPeerBot(store.bot(hermesSpecialist.id)!, store.bot(deskDocs.id)!)).toBe(false);
    expect(visiblePeerBots(store, store.bot(providerChief.id)!).map((bot) => bot.name)).toEqual([
      "Hermes Specialist",
    ]);
    expect(visiblePeerBots(store, store.bot(deskDocs.id)!)).toEqual([]);
  });
});
