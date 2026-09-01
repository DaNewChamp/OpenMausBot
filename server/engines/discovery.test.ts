import { describe, expect, it } from "vitest";

import {
  normalizeCanonicalLookup,
  normalizeProfileRows,
  normalizeProfileRowsResult,
  projectHermesCapabilities,
} from "./discovery.ts";

describe("Hermes discovery normalization", () => {
  it("normalizes the default handle, named slugs, stable order, and bounded safe text", () => {
    const long = "x".repeat(2_000);
    const rows = normalizeProfileRows({
      profiles: [
        {
          name: "Zoo",
          is_default: false,
          display_name: long,
          description: long,
          model: long,
          provider: long,
          path: "/secret/hermes/Zoo",
          ui_meta: { "hermes-bots": true, prompt: "do not copy" },
          canonical_session: { id: "z" },
        },
        {
          name: "default",
          is_default: true,
          display_name: "Default",
          description: "Default profile",
          model: "model-a",
          provider: "provider-a",
          path: "/secret/hermes",
          ui_meta: { token: "secret" },
          canonical_session: { id: "d" },
        },
        {
          name: "alpha_2",
          display_name: "Alpha",
          description: "Alpha profile",
          path: "/secret/hermes/alpha_2",
        },
        { name: "../guess", display_name: "Invalid" },
        { name: "Alpha_2", display_name: "Ambiguous" },
      ],
    });

    expect(rows.map((row) => row.profile)).toEqual(["", "alpha_2", "alpha_2", "default", "zoo"]);
    expect(rows[1]).toMatchObject({ profile: "alpha_2", handle: "alpha_2", availability: "unavailable" });
    expect(rows[2]).toMatchObject({ profile: "alpha_2", handle: "alpha_2", availability: "unavailable" });
    expect(rows[3]).toMatchObject({ profile: "default", handle: "hermes" });
    expect(rows[4]).toMatchObject({ profile: "zoo", handle: "zoo" });
    expect(rows[0].availability).toBe("unavailable");
    expect(rows[4].displayName.length).toBeLessThanOrEqual(120);
    expect(rows[4].description.length).toBeLessThanOrEqual(500);
    expect(rows[4].model?.length).toBeLessThanOrEqual(200);
    expect(rows[4].provider?.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(rows)).not.toContain("/secret/hermes");
    expect(JSON.stringify(rows)).not.toContain("hermes-bots");
    expect(JSON.stringify(rows)).not.toContain("do not copy");
  });

  it("rejects whitespace and overlength profile slugs before display bounding", () => {
    const rows = normalizeProfileRows({
      profiles: [
        { name: " coder ", display_name: "trim me" },
        { name: "x".repeat(65), display_name: "too long" },
        { name: "valid", display_name: "Valid" },
      ],
    });
    expect(rows.find((row) => row.displayName === "trim me")).toMatchObject({
      profile: "",
      handle: "",
      availability: "unavailable",
    });
    expect(rows.find((row) => row.displayName === "too long")).toMatchObject({
      profile: "",
      handle: "",
      availability: "unavailable",
    });
    expect(rows.find((row) => row.displayName === "Valid")).toMatchObject({
      profile: "valid",
      handle: "valid",
      availability: "available",
    });
  });

  it("marks malformed roster payloads as unknown rather than a valid empty roster", () => {
    const malformed = normalizeProfileRows({ profiles: "not-an-array" });
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ availability: "unavailable", canonicalChat: "unknown" });
    expect((malformed as typeof malformed & { state?: string }).state).toBe("unknown");
    const validEmpty = normalizeProfileRows({ profiles: [] });
    expect(validEmpty).toEqual([]);
    expect((validEmpty as typeof validEmpty & { state?: string }).state).toBe("available");
  });

  it.each([
    { error: "profile store unavailable" },
    { ok: false },
    { success: false },
    { failed: true },
    { failure: "profile store unavailable" },
    { status: "error" },
  ])("does not turn an explicit roster failure into an available empty roster (%j)", (marker) => {
    const result = normalizeProfileRowsResult({ profiles: [], ...marker });
    expect(result).toMatchObject({ state: "unknown", code: "state_unavailable", profiles: [] });
  });

  it.each([
    { ok: "true" },
    { success: 1 },
    { failed: null },
    { available: "yes" },
    { error: false },
    { failure: 0 },
    { status: "pending" },
    { status: "unknown" },
    { state: "unknown" },
    { state: "pending" },
  ])("fails closed for malformed or non-success envelope markers (%j)", (marker) => {
    const result = normalizeProfileRowsResult({ profiles: [], ...marker });
    expect(result).toMatchObject({ state: "unknown", code: "state_unavailable", profiles: [] });
  });

  it.each([
    { ok: true },
    { success: true },
    { failed: false },
    { available: true },
    { error: null },
    { failure: null },
    { status: "ok" },
    { status: "success" },
    { status: "available" },
    { status: "ready" },
    { state: "ok" },
    { state: "success" },
    { state: "available" },
    { state: "ready" },
  ])("keeps valid profiles available for recognized success markers (%j)", (marker) => {
    const result = normalizeProfileRowsResult({ profiles: [{ name: "valid" }], ...marker });
    expect(result).toMatchObject({ state: "available" });
    if (result.state === "available") {
      expect(result.profiles).toMatchObject([{ profile: "valid", availability: "available" }]);
    }
  });

  it("sorts every projected field deterministically across input permutations", () => {
    const rows = [
      { name: "same", display_name: "Same", canonical_session: { id: "z" } },
      { name: "same", display_name: "Same", canonical_session: { id: " invalid id " } },
      { name: "other", display_name: "Same", available: false },
    ];
    const permutations = [
      rows,
      [rows[2], rows[0], rows[1]],
      [rows[1], rows[2], rows[0]],
    ];
    const normalized = permutations.map((profiles) => normalizeProfileRowsResult({ profiles }));
    expect(normalized[1]).toEqual(normalized[0]);
    expect(normalized[2]).toEqual(normalized[0]);
    expect(normalized[0].state).toBe("available");
    if (normalized[0].state === "available") {
      expect(normalized[0].profiles.map((row) => row.canonicalChat)).toEqual(["absent", "present", "unknown"]);
    }
  });

  it("fails closed on malformed profile boolean and field types", () => {
    const rows = normalizeProfileRows({
      profiles: [
        { name: "bool-default", is_default: "true" },
        { name: "bool-available", available: "yes" },
        { name: "undefined-available", available: undefined },
        { name: "model-type", model: { name: "not text" } },
        { name: "valid" },
      ],
    });
    expect(rows.find((row) => row.profile === "bool-default")).toMatchObject({ availability: "unavailable" });
    expect(rows.find((row) => row.profile === "bool-available")).toMatchObject({ availability: "unavailable" });
    expect(rows.find((row) => row.profile === "undefined-available")).toMatchObject({ availability: "unavailable" });
    expect(rows.find((row) => row.profile === "model-type")).toMatchObject({ availability: "unavailable" });
    expect(rows.find((row) => row.profile === "valid")).toMatchObject({ availability: "available" });
  });

  it("fails closed for malformed profile payloads", () => {
    expect(normalizeProfileRows({ nope: true })).toMatchObject([{ availability: "unavailable" }]);
    expect(normalizeProfileRows({ profiles: [{ name: "valid", display_name: 4 }] })[0]).toMatchObject({
      profile: "valid",
      availability: "unavailable",
    });
  });

  it("finds an exact hidden Bot Chat and keeps compression lineage internal", () => {
    const result = normalizeCanonicalLookup(
      {
        sessions: [
          { id: "other", resolved_id: "other-tip", title: "Other", hidden: true, source: "cli" },
          {
            id: "root-session",
            resolved_id: "compressed-tip",
            title: "Bot Chat",
            hidden: true,
            source: "tui",
            message_count: 12,
            preview: "hello",
          },
        ],
      },
      "default",
    );
    expect(result).toMatchObject({ state: "present" });
    if (result.state === "present") {
      expect(result.chat).toMatchObject({
        profile: "default",
        title: "Bot Chat",
        rootSessionId: "root-session",
        resolvedSessionId: "compressed-tip",
        messageCount: 12,
        preview: "hello",
      });
    }
  });

  it("rejects trimmed and overlength durable ids instead of silently changing them", () => {
    expect(
      normalizeCanonicalLookup(
        { sessions: [{ id: " root ", resolved_id: "tip", title: "Bot Chat", source: "tui" }] },
        "default",
      ),
    ).toMatchObject({ state: "unknown" });
    expect(
      normalizeCanonicalLookup(
        {
          sessions: [{ id: "r".repeat(257), resolved_id: "tip", title: "Bot Chat", source: "tui" }],
        },
        "default",
      ),
    ).toMatchObject({ state: "unknown" });
    const exact = normalizeCanonicalLookup(
      { sessions: [{ id: "Root-ID/with?exact", resolved_id: "Tip-ID/with?exact", title: "Bot Chat", source: "tui" }] },
      "default",
    );
    expect(exact).toMatchObject({ state: "present" });
    if (exact.state === "present") {
      expect(exact.chat.rootSessionId).toBe("Root-ID/with?exact");
      expect(exact.chat.resolvedSessionId).toBe("Tip-ID/with?exact");
    }
  });

  it("distinguishes absent, denied, and malformed canonical rows", () => {
    expect(normalizeCanonicalLookup({ sessions: [] }, "default")).toMatchObject({ state: "absent" });
    expect(
      normalizeCanonicalLookup(
        { sessions: [{ id: "kanban", resolved_id: "kanban", title: "Bot Chat", source: "kanban" }] },
        "default",
      ),
    ).toMatchObject({ state: "absent" });
    expect(
      normalizeCanonicalLookup(
        { sessions: [{ id: "tool", resolved_id: "tool", title: "Bot Chat", source: "tool" }] },
        "default",
      ),
    ).toMatchObject({ state: "absent" });
    expect(normalizeCanonicalLookup({ sessions: [{ title: "Bot Chat" }] }, "default")).toMatchObject({
      state: "unknown",
    });
    expect(normalizeCanonicalLookup({ error: { code: 5006, message: "db failed" } }, "default")).toMatchObject({
      state: "unknown",
    });
    expect(normalizeCanonicalLookup({ sessions: "not-an-array" }, "default")).toMatchObject({ state: "unknown" });
  });

  it.each([
    { ok: false },
    { success: false },
    { failed: true },
    { status: "error" },
    { status: "pending" },
    { state: "error" },
    { state: "pending" },
    { state: "unknown" },
    { ok: "false" },
    { success: 0 },
    { failed: "true" },
    { status: null },
    { state: 1 },
  ])("never treats an explicit canonical failure or pending marker as absent (%j)", (marker) => {
    const result = normalizeCanonicalLookup({ sessions: [], ...marker }, "default");
    expect(result).toMatchObject({ state: "unknown", code: "state_unavailable" });
  });

  it.each([
    { ok: true },
    { success: true },
    { failed: false },
    { status: "ready" },
    { state: "success" },
  ])("keeps an explicitly successful canonical envelope absent when no session exists (%j)", (marker) => {
    expect(normalizeCanonicalLookup({ sessions: [], ...marker }, "default")).toEqual({ state: "absent" });
  });

  it("denies malformed or whitespace-padded canonical sources", () => {
    expect(
      normalizeCanonicalLookup(
        { sessions: [{ id: "s", resolved_id: "s", title: "Bot Chat", source: " tool " }] },
        "default",
      ),
    ).toMatchObject({ state: "unknown" });
    expect(
      normalizeCanonicalLookup(
        { sessions: [{ id: "s", resolved_id: "s", title: "Bot Chat", source: { name: "tui" } }] },
        "default",
      ),
    ).toMatchObject({ state: "unknown" });
    expect(normalizeCanonicalLookup({ sessions: [{ id: "s", resolved_id: "s", title: "Bot Chat" }] }, "default"))
      .toMatchObject({ state: "unknown" });
  });

  it("sorts with codepoint order instead of locale-dependent collation", () => {
    const rows = normalizeProfileRows({ profiles: [{ name: "z" }, { name: "b" }, { name: "a" }, { name: "c" }] });
    expect(rows.map((row) => row.profile)).toEqual(["a", "b", "c", "z"]);
  });

  it("keeps only transport-proven supported capabilities", () => {
    expect(projectHermesCapabilities({})).toEqual({
      roster: false,
      canonicalChat: false,
      send: false,
      finalResponse: false,
      events: false,
      stop: false,
      routinesRead: false,
      messageAgent: false,
      groups: false,
      crossMachine: false,
      queueing: false,
      steer: false,
      attachments: false,
    });
  });
});
