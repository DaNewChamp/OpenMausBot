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
    const error = new HermesEngineError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message).toBe("Hermes state is unavailable");
    expect(Object.keys(error)).toEqual(["code"]);
    expect(`${error}`).not.toContain("/private");
    const groups = new HermesEngineError("groups_unavailable");
    expect(groups.message).toBe("Hermes does not support groups");
    expect(groups.code).toBe("groups_unavailable");
  });

  it("never exposes caller-controlled diagnostics in its public message", () => {
    const payloads = [
      "/private/hermes/state.db",
      "../relative/hermes --query secret",
      "argv: hermes --profile coder",
      "stderr: provider token leaked",
      "query text with a secret",
      { path: "/private/hermes" },
    ];
    for (const payload of payloads) {
      const error = new HermesEngineError("malformed_response", payload as never);
      expect(error.message).toBe("Hermes returned an invalid response");
      expect(`${error}`).not.toContain("private");
      expect(`${error}`).not.toContain("relative");
      expect(`${error}`).not.toContain("secret");
      expect(`${error}`).not.toContain("provider");
    }
  });
});
