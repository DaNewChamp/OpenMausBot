import { describe, expect, it } from "vitest";

import {
  normalizeCanonicalLookup,
  normalizeProfileRows,
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

  it("fails closed for malformed profile payloads", () => {
    expect(normalizeProfileRows({ nope: true })).toEqual([]);
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
