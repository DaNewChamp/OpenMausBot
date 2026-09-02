import { describe, expect, it } from "vitest";

import { projectHermesGatewayToolEvent, projectHermesMessageAgent, projectHermesSubagentGatewayEvent } from "./hermes-events.ts";

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

  it("projects live Hermes agent and spawn_agent events into the existing subagent types", () => {
    const started = projectHermesSubagentGatewayEvent({
      ...baseInput,
      type: "agent.started",
      payload: { id: "moa-temp-1", name: "Draft review", kind: "temporary" },
    });
    expect(started).toMatchObject({
      action: "start",
      hermesAgentId: "moa-temp-1",
      kind: "temporary",
      name: "Draft review",
    });

    const persistent = projectHermesSubagentGatewayEvent({
      ...baseInput,
      type: "subagent.started",
      payload: { agent_id: "hermes-researcher", title: "Researcher", persistent: true },
    });
    expect(persistent).toMatchObject({
      action: "start",
      hermesAgentId: "hermes-researcher",
      kind: "persistent",
      name: "Researcher",
    });

    const spawned = projectHermesSubagentGatewayEvent({
      ...baseInput,
      type: "tool.start",
      payload: { name: "spawn_agent", arguments: { id: "moa-temp-2", name: "Reviewer" } },
    });
    expect(spawned).toMatchObject({
      action: "start",
      hermesAgentId: "moa-temp-2",
      kind: "temporary",
      name: "Reviewer",
    });

    const completed = projectHermesSubagentGatewayEvent({
      ...baseInput,
      type: "agent.completed",
      payload: { id: "moa-temp-1", text: "draft notes" },
    });
    expect(completed).toMatchObject({
      action: "complete",
      hermesAgentId: "moa-temp-1",
      text: "draft notes",
    });
    expect(JSON.stringify(started)).not.toMatch(/token|HERMES_HOME|\/Users\/|sk-/i);
  });
});
