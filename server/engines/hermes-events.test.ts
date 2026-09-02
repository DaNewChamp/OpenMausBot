import { describe, expect, it } from "vitest";

import { projectHermesMessageAgent } from "./hermes-events.ts";

describe("hermes-events", () => {
  it("projects message_agent tool payloads into comm candidates", () => {
    const projection = projectHermesMessageAgent(
      {
        type: "tool.start",
        sessionId: "runtime",
        threadId: "thread-1",
        turnId: "turn-1",
        fromBotId: "bot-a",
        senderHandle: "coder",
        handleToBotId: new Map([["researcher", "bot-b"]]),
        createdAt: new Date().toISOString(),
      },
      {
        name: "message_agent",
        arguments: { target: "researcher", message: "ship it" },
      },
    );
    expect(projection.comm).toMatchObject({
      plane: "hermesMessageAgent",
      fromBotId: "bot-a",
      toBotId: "bot-b",
      text: "ship it",
    });
    expect(projection.events[0]).toMatchObject({ type: "item.started", itemType: "tool" });
  });
});
