import { describe, expect, it } from "vitest";

import { createTeamManifest, parseTeamManifest } from "./team-manifest.ts";

describe("team manifests", () => {
  it("exports portable member keys and room routing without runtime state", () => {
    const manifest = createTeamManifest(
      {
        name: "Launch Crew",
        memberIds: ["bot-a", "bot-b"],
        bulletin: "Ship together",
        defaultResponder: { kind: "member", botId: "bot-b" },
      },
      [
        {
          id: "bot-a",
          name: "Mira",
          title: "Lead",
          description: "Coordinates the work",
          color: "purple",
          mascotExpression: "focused",
        },
        {
          id: "bot-b",
          name: "Mira",
          title: "Researcher",
          description: "Finds evidence",
          color: "cyan",
        },
      ],
    );

    expect(manifest).toMatchObject({
      format: "openmaus.team",
      version: 1,
      team: {
        name: "Launch Crew",
        members: [{ key: "mira" }, { key: "mira-2" }],
        room: {
          bulletin: "Ship together",
          defaultResponder: { kind: "member", member: "mira-2" },
        },
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/bot-a|bot-b|thread|model|permission|message/i);
  });

  it("parses the supported portable fields and drops unrelated settings", () => {
    const manifest = parseTeamManifest({
      format: "openmaus.team",
      version: 1,
      team: {
        name: "  Research Lab  ",
        members: [
          {
            key: "analyst",
            name: " Ada ",
            title: " Analyst ",
            description: " Checks the evidence ",
            appearance: { color: "green" },
            modelSelection: { instanceId: "private-machine" },
            alwaysAllow: ["everything"],
          },
        ],
        room: {
          name: " Research Room ",
          bulletin: " Compare sources ",
          defaultResponder: { kind: "member", member: "analyst" },
          computer: "local",
        },
      },
    });

    expect(manifest.team.name).toBe("Research Lab");
    expect(manifest.team.members[0]).toEqual({
      key: "analyst",
      name: "Ada",
      title: "Analyst",
      description: "Checks the evidence",
      appearance: { color: "green" },
    });
    expect(manifest.team.room).toEqual({
      name: "Research Room",
      bulletin: "Compare sources",
      defaultResponder: { kind: "member", member: "analyst" },
    });
  });

  it("rejects unsupported versions and dangling member references", () => {
    expect(() => parseTeamManifest({ format: "openmaus.team", version: 99 })).toThrow("not supported");
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: {
          name: "Broken",
          members: [
            {
              key: "one",
              name: "One",
              appearance: { color: "blue" },
            },
          ],
          room: {
            name: "Broken",
            bulletin: "",
            defaultResponder: { kind: "member", member: "missing" },
          },
        },
      }),
    ).toThrow("Unknown default responder");
  });
});
