import { describe, expect, it } from "vitest";

import { botSelfAwarenessCatalog, botSelfAwarenessPersona } from "./bot-self-awareness.ts";

describe("bot self-awareness", () => {
  it("names V Bot in persona and chief role", () => {
    const text = botSelfAwarenessPersona({
      id: "chief",
      name: "Chief Keef",
      title: "Chief of Staff",
      section: "General",
      chiefOfStaff: true,
    });
    expect(text).toContain("V Bot");
    expect(text).toContain("Chief of Staff");
  });

  it("lists mounted agents and composio tools", () => {
    const text = botSelfAwarenessCatalog(
      { id: "b1", name: "Chief", chiefOfStaff: true },
      { agents: {}, composio: {} },
    );
    expect(text).toContain("create_bot");
    expect(text).toContain("list_routines");
    expect(text).toContain("COMPOSIO_SEARCH_TOOLS");
  });

  it("notes manager and team-lead powers in persona", () => {
    const specialist = botSelfAwarenessPersona({
      id: "a1",
      name: "Ada",
      title: "Analyst",
      reportsToBotId: "lead",
      reportsToName: "Inv",
      reportsToTitle: "Chief of Investments",
    });
    expect(specialist).toContain("You report to Inv (Chief of Investments)");

    const lead = botSelfAwarenessPersona({
      id: "lead",
      name: "Inv",
      title: "Chief of Investments",
      reportsToBotId: "chief",
      reportsToName: "Atlas",
      reportsToTitle: "Chief of Staff",
    });
    expect(lead).toContain("use create_bot to add specialists");
  });
});
