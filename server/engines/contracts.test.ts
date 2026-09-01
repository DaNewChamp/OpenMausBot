import { describe, expect, it } from "vitest";

import {
  HERMES_CAPABILITY_KEYS,
  HermesEngineError,
  type HermesCapabilityFlags,
  type HermesFailureCode,
} from "./contracts.ts";
import { projectHermesCapabilities } from "./discovery.ts";

describe("Hermes internal contracts", () => {
  it("keeps the exact capability keys and disables unsupported operations", () => {
    expect(HERMES_CAPABILITY_KEYS).toEqual([
      "roster",
      "canonicalChat",
      "send",
      "finalResponse",
      "events",
      "stop",
      "routinesRead",
      "messageAgent",
      "groups",
      "crossMachine",
      "queueing",
      "steer",
      "attachments",
    ]);

    const projected = projectHermesCapabilities({
      roster: true,
      canonicalChat: true,
      send: true,
      finalResponse: true,
      events: true,
      stop: true,
      routinesRead: true,
      messageAgent: true,
      groups: true,
      crossMachine: true,
      queueing: true,
      steer: true,
      attachments: true,
    });
    expect(Object.keys(projected)).toEqual(HERMES_CAPABILITY_KEYS);
    expect(projected).toEqual({
      roster: true,
      canonicalChat: true,
      send: true,
      finalResponse: true,
      events: true,
      stop: true,
      routinesRead: false,
      messageAgent: false,
      groups: false,
      crossMachine: false,
      queueing: false,
      steer: false,
      attachments: false,
    } satisfies HermesCapabilityFlags);
  });

  it("exposes only a stable failure code and safe human message", () => {
    const code: HermesFailureCode = "state_unavailable";
    const error = new HermesEngineError(code, "Hermes state is unavailable");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message).toBe("Hermes state is unavailable");
    expect(Object.keys(error)).toEqual(["code"]);
    expect(`${error}`).not.toContain("/private");
  });
});
