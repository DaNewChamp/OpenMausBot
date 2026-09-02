import { describe, expect, it } from "vitest";

import {
  BRIDGE_OPT_IN_ENV_KEYS,
  bridgeEnvEnabled,
  bridgeEnvFromProcessEnv,
  launchdEnvPlistFragment,
} from "./deploy-bridge.mjs";

describe("bridge installer launchd env contract", () => {
  it("tracks every opt-in bridge capability env key", () => {
    expect(BRIDGE_OPT_IN_ENV_KEYS).toEqual([
      "OMB_BRIDGE_SHELL",
      "OMB_BRIDGE_LOCAL_VM",
      "OMB_BRIDGE_SSH_FORWARD",
      "OMB_BRIDGE_HERMES",
    ]);
  });

  it("enables opt-in env only for explicit 1 or true", () => {
    expect(bridgeEnvEnabled("1")).toBe(true);
    expect(bridgeEnvEnabled("true")).toBe(true);
    for (const value of [undefined, "", "0", "false", "yes", "on", "2"]) {
      expect(bridgeEnvEnabled(value)).toBe(false);
    }
  });

  it("persists only explicitly enabled opt-in env vars into launchd", () => {
    const bridgeEnv = bridgeEnvFromProcessEnv({
      OMB_BRIDGE_SHELL: "1",
      OMB_BRIDGE_LOCAL_VM: "true",
      OMB_BRIDGE_SSH_FORWARD: "0",
      OMB_BRIDGE_HERMES: "1",
      OMB_BRIDGE_URL: "https://example.test",
    });
    expect(bridgeEnv).toEqual([
      ["OMB_BRIDGE_SHELL", "1"],
      ["OMB_BRIDGE_LOCAL_VM", "true"],
      ["OMB_BRIDGE_HERMES", "1"],
    ]);
    expect(launchdEnvPlistFragment(bridgeEnv)).toBe(
      '  <key>EnvironmentVariables</key><dict><key>OMB_BRIDGE_SHELL</key><string>1</string><key>OMB_BRIDGE_LOCAL_VM</key><string>true</string><key>OMB_BRIDGE_HERMES</key><string>1</string></dict>\n',
    );
  });

  it("omits OMB_BRIDGE_HERMES from launchd unless explicitly enabled", () => {
    for (const env of [
      {},
      { OMB_BRIDGE_HERMES: "0" },
      { OMB_BRIDGE_HERMES: "false" },
      { OMB_BRIDGE_HERMES: "yes" },
      { OMB_BRIDGE_SHELL: "1" },
    ]) {
      const bridgeEnv = bridgeEnvFromProcessEnv(env);
      expect(bridgeEnv.some(([key]) => key === "OMB_BRIDGE_HERMES")).toBe(false);
    }
    expect(launchdEnvPlistFragment([])).toBe("");
  });

  it("includes OMB_BRIDGE_HERMES in launchd only for explicit 1 or true", () => {
    expect(bridgeEnvFromProcessEnv({ OMB_BRIDGE_HERMES: "1" })).toEqual([["OMB_BRIDGE_HERMES", "1"]]);
    expect(bridgeEnvFromProcessEnv({ OMB_BRIDGE_HERMES: "true" })).toEqual([["OMB_BRIDGE_HERMES", "true"]]);
  });
});
