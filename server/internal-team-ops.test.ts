import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";

import {
  canManageRoutine,
  createRoomForChief,
  createRoutineForBot,
  listRoomsForBot,
  listRoutinesForBot,
  updateRoomForChief,
} from "./internal-team-ops.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

function routineManager(store: Store) {
  return new RoutineManager({
    file: join(DATA_DIR, "routines-test.json"),
    botState: (botId) => (store.bot(botId) ? "ready" : "missing"),
    createTask: () => ({ threadId: "routine-thread" }),
    startTurn: async () => {},
  });
}

describe("internal team ops", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("lists rooms for a member bot", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Work" }, { seedMessages: false });
    store.setChiefOfStaff(chief.id);
    const helper = store.createBot({ name: "Helper", section: "Work" }, { seedMessages: false });
    const room = createRoomForChief(store, chief.id, { memberIds: [chief.id, helper.id], name: "Standup" });
    const listed = listRoomsForBot(store, helper.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(room.id);
    expect(listed[0]?.name).toBe("Standup");
  });

  it("rejects room creation from non-chiefs", () => {
    const store = new Store(selection);
    const peer = store.createBot({ name: "Peer", section: "Work" }, { seedMessages: false });
    expect(() => createRoomForChief(store, peer.id, { memberIds: [peer.id] })).toThrow(/Chief of Staff/);
  });

  it("rejects Hermes-bound bots and unreadable binding state from room membership", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Work" }, { seedMessages: false });
    store.setChiefOfStaff(chief.id);
    const helper = store.createBot({ name: "Helper", section: "Work" }, { seedMessages: false });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [helper.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });
    expect(() => createRoomForChief(store, chief.id, { memberIds: [chief.id, helper.id], name: "Standup" })).toThrow(/does not support groups/);
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    expect(() => createRoomForChief(store, chief.id, { memberIds: [chief.id], name: "Unknown" })).toThrow(/invalid response/);
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), JSON.stringify({ version: 1, bindings: {} }), { mode: 0o600 });
    const room = createRoomForChief(store, chief.id, { memberIds: [chief.id], name: "Standup" });
    expect(room.memberIds).toEqual([chief.id]);
    writeFileSync(join(DATA_DIR, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [helper.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });
    expect(() => updateRoomForChief(store, chief.id, room.id, { memberIds: [chief.id, helper.id] })).toThrow(/does not support groups/);
  });

  it("filters routines to the caller's section", () => {
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief", section: "Work" }, { seedMessages: false });
    store.setChiefOfStaff(chief.id);
    const helper = store.createBot({ name: "Helper", section: "Work" }, { seedMessages: false });
    store.createBot({ name: "Other", section: "Home" }, { seedMessages: false });
    const routines = routineManager(store);
    createRoutineForBot(store, chief.id, routines, {
      name: "Daily sync",
      prompt: "Summarize inbox",
      botId: helper.id,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    });
    const listed = listRoutinesForBot(store, chief.id, routines);
    expect(listed).toHaveLength(1);
    expect(canManageRoutine(store, chief.id, helper.id)).toBe(true);
    expect(canManageRoutine(store, helper.id, helper.id)).toBe(true);
    expect(canManageRoutine(store, helper.id, chief.id)).toBe(false);
  });
});
