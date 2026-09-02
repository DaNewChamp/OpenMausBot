import { describe, expect, it } from "vitest";

import { projectHermesGatewayToolEvent, projectHermesMessageAgent } from "./hermes-events.ts";

const baseInput = {
  sessionId: "runtime",
  threadId: "thread-1",
  turnId: "turn-1",
  fromBotId: "bot-a",
  senderHandle: "coder",
  handleToBotId: new Map([["researcher", "bot-b"]]),
  createdAt: new Date().toISOString(),
};

describe("hermes-events", () => {
  it("projects message_agent tool payloads into comm candidates", () => {
    const projection = projectHermesMessageAgent(
      { ...baseInput, type: "tool.start" },
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

  it("handles message_agent only on tool.start and tool.call", () => {
    const args = { target: "researcher", message: "ship it" };
    const start = projectHermesGatewayToolEvent({
      ...baseInput,
      type: "tool.start",
      payload: { name: "message_agent", arguments: args },
    });
    expect(start?.comm).toBeTruthy();

    const call = projectHermesGatewayToolEvent({
      ...baseInput,
      type: "tool.call",
      payload: { name: "message_agent", arguments: args },
    });
    expect(call?.comm).toBeTruthy();

    const complete = projectHermesGatewayToolEvent({
      ...baseInput,
      type: "tool.complete",
      payload: { name: "message_agent", arguments: args, ok: true, status: "complete" },
    });
    expect(complete).toBeNull();
  });
});
