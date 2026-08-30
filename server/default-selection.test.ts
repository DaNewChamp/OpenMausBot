import { describe, expect, it } from "vitest";

import { defaultModelSelection } from "./default-selection.ts";

const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available" as const },
  models: { default: "claude-sonnet-5" },
};

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  snapshot: { state: "available" as const },
  models: { default: "gpt-5.6-sol" },
};

const cursor = {
  instanceId: "cursor",
  driverKind: "cursorAgent",
  snapshot: { state: "available" as const },
  models: { default: "auto" },
};

describe("defaultModelSelection", () => {
  it("prefers Codex over Claude when both CLIs are installed", () => {
    expect(defaultModelSelection([claude, cursor, codex])).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("does not use Cursor as the chat engine when Codex is available", () => {
    expect(defaultModelSelection([cursor, codex]).instanceId).toBe("codex");
  });

  it("falls back to another installed engine when Codex is missing", () => {
    expect(defaultModelSelection([cursor, claude])).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5",
    });
  });

  it("uses Cursor only when it is the sole available engine", () => {
    expect(defaultModelSelection([cursor])).toEqual({
      instanceId: "cursor",
      model: "auto",
    });
  });

  it("stays empty when no CLI is available, rather than assigning a missing engine", () => {
    expect(
      defaultModelSelection([
        { ...claude, snapshot: { state: "unavailable" } },
        { ...codex, snapshot: { state: "unavailable" } },
      ]),
    ).toEqual({ instanceId: "", model: "" });
  });
});
