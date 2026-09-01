import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadHermesBindings } from "./engines/bindings.ts";
import {
  hermesGroupDispatchError,
  hermesGroupMembershipError,
  hermesGroupsUnavailable,
  hermesSetupJson,
} from "./hermes-groups.ts";

const binding = {
  adapter: "hermesBot" as const,
  profile: "default",
  canonicalTitle: "Bot Chat" as const,
  bindingVersion: 1 as const,
};

function sidecar(dir: string, contents: string | object): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "hermes-bindings.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents), { mode: 0o600 });
  return file;
}

describe("Hermes group membership and room dispatch gates", () => {
  it("uses a stable groups-unavailable setup error", () => {
    const error = hermesGroupsUnavailable();
    expect(error.code).toBe("groups_unavailable");
    expect(error.message).toBe("Hermes does not support groups");
    expect(hermesSetupJson(error)).toEqual({
      error: "Hermes does not support groups",
      code: "groups_unavailable",
      setup: true,
    });
    expect(error.message).not.toMatch(/HERMES_HOME|profile|session|token/i);
  });

  it("rejects a valid Hermes-bound bot from room membership and send", () => {
    const file = sidecar(mkdtempSync(join(tmpdir(), "vbot-hermes-groups-bound-")), {
      version: 1,
      bindings: { "bot-bound": binding },
    });
    const load = () => loadHermesBindings(file);
    expect(hermesGroupMembershipError(["bot-unbound", "bot-bound"], load)).toMatchObject({
      code: "groups_unavailable",
      message: "Hermes does not support groups",
    });
    expect(hermesGroupDispatchError("bot-bound", load)).toMatchObject({
      code: "groups_unavailable",
    });
    expect(hermesGroupMembershipError(["bot-unbound"], load)).toBeNull();
    expect(hermesGroupDispatchError("bot-unbound", load)).toBeNull();
  });

  it("rejects unreadable binding state instead of treating it as unbound", () => {
    const file = sidecar(mkdtempSync(join(tmpdir(), "vbot-hermes-groups-bad-")), "{not-json");
    const load = () => loadHermesBindings(file);
    expect(hermesGroupMembershipError(["bot-any"], load)).toMatchObject({
      code: "malformed_response",
      message: "Hermes returned an invalid response",
    });
    expect(hermesGroupDispatchError("bot-any", load)).toMatchObject({
      code: "malformed_response",
    });
  });
});
