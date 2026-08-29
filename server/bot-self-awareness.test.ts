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
});
