import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHermesBridgeBinding } from "./bridge-hermes-bindings.ts";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Hermes bridge-authenticated tool facade", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  });
  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("allows list_bots for a bot bound to the calling bridge and rejects other bridges", async () => {
    const { evaluateHermesBridgeToolScope } = await import("./hermes-bridge-tools.ts");
    const store = new Store(selection);
    const bot = store.createBot({ name: "Chief" }, { seedMessages: false });
    store.patchBot(bot.id, {
      runtimeBinding: {
        kind: "hermes",
        placement: { kind: "bridge", bridgeId: "bridge-mini", profile: "default" },
        bindingVersion: 2,
      },
    });
    expect(setHermesBridgeBinding(bot.id, {
      bridgeId: "bridge-mini",
      profile: "default",
      bindingVersion: 1,
    }).state).toBe("available");

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: bot.id,
      name: "list_bots",
      args: {},
    })).toEqual({ ok: true, botId: bot.id });

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-other",
      botScope: bot.id,
      name: "list_bots",
      args: {},
    })).toMatchObject({ ok: false, code: "bot_scope" });
  });

  it("rejects unknown tools, missing bot scope, and out-of-section targets", async () => {
    const { evaluateHermesBridgeToolScope } = await import("./hermes-bridge-tools.ts");
    const store = new Store(selection);
    const chief = store.createBot({ name: "Chief" }, { seedMessages: false });
    const outsider = store.createBot({ name: "Other section", section: "Sales" }, { seedMessages: false });
    store.patchBot(chief.id, {
      runtimeBinding: {
        kind: "hermes",
        placement: { kind: "bridge", bridgeId: "bridge-mini", profile: "default" },
        bindingVersion: 2,
      },
    });

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: chief.id,
      name: "rm_rf",
      args: {},
    })).toMatchObject({ ok: false, code: "unknown_tool" });

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: "",
      name: "list_bots",
      args: {},
    })).toMatchObject({ ok: false, code: "bot_scope" });

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: chief.id,
      name: "ask_bot",
      args: { bot_id: outsider.id, message: "hi" },
    })).toMatchObject({ ok: false, code: "bot_scope" });
  });

  it("lets a trusted Hermes chief message another section without widening bridge scope", async () => {
    const { evaluateHermesBridgeToolScope } = await import("./hermes-bridge-tools.ts");
    const store = new Store(selection);
    const chief = store.createBot({ name: "Hermes Chief" }, { seedMessages: false });
    const specialist = store.createBot({ name: "Hermes Specialist" }, { seedMessages: false });
    const deskDocs = store.createBot({ name: "Desk Docs", section: "Desk" }, { seedMessages: false });
    const binding = {
      kind: "hermes" as const,
      placement: { kind: "bridge" as const, bridgeId: "bridge-mini", profile: "default" },
      bindingVersion: 2 as const,
    };
    store.patchBot(chief.id, { runtimeBinding: binding });
    store.patchBot(specialist.id, { runtimeBinding: binding });
    store.setChiefOfStaff(chief.id);

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: chief.id,
      name: "ask_bot",
      args: { bot_id: deskDocs.id, message: "summarize the desk" },
    })).toEqual({ ok: true, botId: chief.id });
    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: chief.id,
      name: "delegate_bot",
      args: { bot_id: deskDocs.id, message: "file the notes" },
    })).toEqual({ ok: true, botId: chief.id });

    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: specialist.id,
      name: "ask_bot",
      args: { bot_id: deskDocs.id, message: "summarize the desk" },
    })).toMatchObject({ ok: false, code: "bot_scope" });
    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-other",
      botScope: chief.id,
      name: "ask_bot",
      args: { bot_id: deskDocs.id, message: "summarize the desk" },
    })).toMatchObject({ ok: false, code: "bot_scope" });
    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: chief.id,
      name: "configure_bot",
      args: { bot_id: deskDocs.id, role: "Docs" },
    })).toMatchObject({ ok: false, code: "bot_scope" });

    store.patchBot(deskDocs.id, { hidden: true });
    expect(evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: chief.id,
      name: "ask_bot",
      args: { bot_id: deskDocs.id, message: "summarize the desk" },
    })).toMatchObject({ ok: false, code: "bot_scope" });
  });

  it("never puts hub or bridge secrets in facade errors or snapshots", async () => {
    const { evaluateHermesBridgeToolScope, hermesBridgeToolsPath } = await import("./hermes-bridge-tools.ts");
    const store = new Store(selection);
    const result = evaluateHermesBridgeToolScope({
      store,
      bridgeId: "bridge-mini",
      botScope: "missing-bot",
      name: "list_bots",
      args: { token: "sk-secret", OMB_COMMS_TOKEN: "comms-secret" },
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toMatch(/sk-secret|comms-secret|OMB_COMMS_TOKEN|Bearer/i);
    expect(hermesBridgeToolsPath()).toBe("/api/bridge/hermes-tools");
  });
});
