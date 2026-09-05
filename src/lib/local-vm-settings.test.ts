import { describe, expect, it } from "vitest";
import { localVmSettingsBotId, localVmSettingsActionPath, localVmContainerExists } from "./local-vm-settings";

const bots = [{ id: "first" }, { id: "selected" }];

describe("Local VM Settings target ownership", () => {
  it("targets the selected conversation, never the first bot's private container", () => {
    expect(localVmSettingsBotId({ bots, selectedId: "selected", mode: "per-bot" })).toBe("selected");
  });
  it("requires a chosen bot from a room in per-bot mode", () => {
    expect(localVmSettingsBotId({ bots, selectedId: "room", mode: "per-bot" })).toBeNull();
    expect(localVmSettingsBotId({ bots, selectedId: "room", mode: "shared" })).toBe("first");
  });
  it("honors an explicit target and fails closed when that bot is removed", () => {
    expect(localVmSettingsBotId({ bots, selectedId: "selected", explicitBotId: "first", mode: "per-bot" })).toBe("first");
    expect(localVmSettingsBotId({ bots, selectedId: "selected", explicitBotId: "deleted", mode: "per-bot" })).toBeNull();
    expect(localVmSettingsBotId({ bots, selectedId: "selected", explicitBotId: "", mode: "per-bot" })).toBeNull();
    expect(localVmSettingsBotId({ bots: [], selectedId: "room", mode: "shared" })).toBeNull();
  });
  it.each(["run", "stop", "remove", "recreate"] as const)("routes private %s to exactly the selected bot", (action) => {
    expect(localVmSettingsActionPath({ botId: "selected", mode: "per-bot", action })).toBe(`/api/bots/selected/local-computer/${action}`);
  });
  it("resumes private containers through the guarded run route", () => {
    expect(localVmSettingsActionPath({ botId: "selected", mode: "per-bot", action: "start" })).toBe("/api/bots/selected/local-computer/run");
  });
  it.each(["run", "stop", "remove", "recreate"] as const)("keeps shared %s on the shared lifecycle route", (action) => {
    expect(localVmSettingsActionPath({ botId: "selected", mode: "shared", action })).toBe(`/api/local-computer/${action}`);
  });
  it("cannot silently delete the shared container when a private target is missing", () => {
    expect(() => localVmSettingsActionPath({ botId: null, mode: "per-bot", action: "remove" })).toThrow(/choose a bot/i);
  });
  it("keeps image preparation separate from bot lifecycle", () => {
    expect(localVmSettingsActionPath({ botId: null, mode: "per-bot", action: "pull" })).toBe("/api/local-computer/pull");
  });
  it("uses the real companion lifecycle for shared and private browser clients", () => {
    for (const mode of ["shared", "per-bot"] as const) {
      for (const action of ["run", "stop", "recreate"] as const) {
        expect(localVmSettingsActionPath({ botId: "selected", mode, action, pairedClient: true })).toBe(`/api/bots/selected/local-computer/${action}`);
      }
    }
    expect(() => localVmSettingsActionPath({ botId: "selected", mode: "shared", action: "remove", pairedClient: true })).toThrow(/desktop/i);
    expect(() => localVmSettingsActionPath({ botId: "selected", mode: "shared", action: "pull", pairedClient: true })).toThrow(/desktop/i);
    expect(() => localVmSettingsActionPath({ botId: null, mode: "shared", action: "run", pairedClient: true })).toThrow(/choose a bot/i);
  });
  it("never offers container deletion without an observed container", () => {
    expect(localVmContainerExists(null)).toBe(false);
    expect(localVmContainerExists(undefined)).toBe(false);
    expect(localVmContainerExists({ container: "missing" })).toBe(false);
    expect(localVmContainerExists({ container: "running" })).toBe(true);
    expect(localVmContainerExists({ container: "stopped" })).toBe(true);
  });
});
