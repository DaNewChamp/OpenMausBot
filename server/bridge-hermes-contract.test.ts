import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import {
  encodeHermesBridgeResult,
  HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH,
  parseHermesBridgeResult,
  projectHermesDiscoveryWire,
  scrubRuntimeEvent,
  scrubRuntimeEvents,
  validHermesBridgeProfile,
  wireContainsForbiddenMaterial,
} from "../shared/bridge-hermes-contract.ts";

describe("Hermes bridge wire contract", () => {
  it("scrubs runtime events and drops forbidden fields", () => {
    const event = {
      eventId: "evt-1",
      provider: "hermesBot",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-01T00:00:00.000Z",
      type: "content.delta",
      streamKind: "assistant_text",
      delta: "hello",
      raw: { source: "hermes", payload: { session_id: "secret" } },
    } as RuntimeEvent;
    expect(scrubRuntimeEvent(event)).toEqual({
      eventId: "evt-1",
      provider: "hermesBot",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-01T00:00:00.000Z",
      type: "content.delta",
      streamKind: "assistant_text",
      delta: "hello",
    });
    expect(JSON.stringify(scrubRuntimeEvent(event))).not.toMatch(/session_id|jsonrpc|HERMES_HOME/i);
  });

  it("rejects wire payloads containing forbidden material", () => {
    expect(wireContainsForbiddenMaterial({ text: "Bearer secret-token" })).toBe(true);
    expect(wireContainsForbiddenMaterial({ path: "/Users/vincent/.hermes" })).toBe(true);
    expect(wireContainsForbiddenMaterial({ ok: true, turnId: "turn-1", events: [] })).toBe(false);
  });

  it("bounds scrubbed event lists", () => {
    const events = Array.from({ length: 80 }, (_, index) => ({
      eventId: `evt-${index}`,
      provider: "hermesBot" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-01T00:00:00.000Z",
      type: "content.delta" as const,
      streamKind: "assistant_text" as const,
      delta: "x",
    }));
    expect(scrubRuntimeEvents(events)).toHaveLength(64);
  });

  it("round-trips encoded bridge results without forbidden keys", () => {
    const discovery = projectHermesDiscoveryWire({
      state: "available",
      capabilities: {
        roster: true,
        canonicalChat: true,
        send: true,
        finalResponse: true,
        events: true,
        stop: true,
        routinesRead: false,
        messageAgent: false,
        groups: false,
        crossMachine: false,
        queueing: false,
        steer: false,
        attachments: false,
        adoptMint: false,
        approvals: false,
        exclusiveSubmit: false,
      },
      profiles: [{
        profile: "default",
        handle: "hermes",
        displayName: "Hermes",
        description: "Local assistant",
        canonicalChat: "absent",
        availability: "available",
      }],
    });
    const encoded = encodeHermesBridgeResult({ kind: "hermes-discover", body: discovery });
    expect(parseHermesBridgeResult(encoded)).toEqual({ kind: "hermes-discover", body: discovery });
    expect(encoded).not.toMatch(/session|jsonrpc|HERMES_HOME|\/Users\//i);
  });

  it("fails closed when parsing forbidden bridge stdout", () => {
    expect(() => parseHermesBridgeResult(JSON.stringify({
      kind: "hermes-send",
      body: { ok: true, turnId: "turn-1", events: [], stderr: "secret" },
    }))).toThrow(/forbidden material|invalid/i);
  });

  it("bounds oversized event payloads during scrubbing", () => {
    const huge = "x".repeat(HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH + 1);
    const event = {
      eventId: "evt-1",
      provider: "hermesBot",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-09-01T00:00:00.000Z",
      type: "content.delta",
      streamKind: "assistant_text",
      delta: huge,
      text: huge,
      message: huge,
      title: huge,
    } as RuntimeEvent;
    const scrubbed = scrubRuntimeEvent(event);
    expect(scrubbed).not.toBeNull();
    expect(JSON.stringify(scrubbed).length).toBeLessThanOrEqual(HERMES_BRIDGE_MAX_EVENT_JSON_LENGTH);
  });

  it("rejects structurally invalid bridge results", () => {
    expect(() => parseHermesBridgeResult(JSON.stringify({
      kind: "hermes-send",
      body: { ok: true, turnId: 123, events: [] },
    }))).toThrow(/send body is invalid/i);
  });

  it("validates profile slugs at the contract boundary", () => {
    expect(validHermesBridgeProfile("default")).toBe("default");
    expect(validHermesBridgeProfile("../escape")).toBeUndefined();
  });
});
