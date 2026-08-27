// The allowlist.
//
// The proxy tests prove the app's own calls reach a real harness. These prove
// the other half, which no end-to-end test can: that everything else does
// not. The case worth caring about is the last one — a route nobody here has
// heard of is denied, because that is the property the whole file exists for
// and the one that quietly stopped being true once before.
import { describe, expect, it } from "vitest";

import {
  denyReason,
  validateConnectorCardBody,
  validateConnectorCardThreadId,
  validateLocalVmActionBody,
} from "../src/routes.ts";

const ask = (method: string, path: string, authenticated = true) =>
  denyReason({ method, path, authenticated });

const allowed = (method: string, path: string) => ask(method, path) === null;

describe("credentials", () => {
  it("lets an unpaired device pair, and do nothing else", () => {
    expect(ask("POST", "/api/pair", false)).toBeNull();
    expect(ask("GET", "/api/bots", false)?.status).toBe(401);
  });

  it("lets anyone curl liveness — it is the unauthenticated smoke test", () => {
    expect(ask("GET", "/api/health", false)).toBeNull();
    // the bypass is one method on one path, not a family
    expect(ask("POST", "/api/health", false)?.status).toBe(401);
    expect(ask("GET", "/api/healthz", false)?.status).toBe(401);
  });
});

describe("what the app may do", () => {
  // Every request in ios/Sources/CompanionCore/Client.swift. If one of these
  // fails, a screen on the phone is broken.
  const calls: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/events"],
    ["GET", "/api/instances"],
    ["GET", "/api/companion/endpoints"],
    ["GET", "/api/bots"],
    ["POST", "/api/bots"],
    ["POST", "/api/bots/bot_123/messages"],
    ["POST", "/api/bots/bot_123/interrupt"],
    ["POST", "/api/bots/bot_123/read"],
    ["POST", "/api/bots/bot_123/always-allow"],
    ["POST", "/api/bots/bot_123/messages/msg_2/edit"],
    ["POST", "/api/bots/bot_123/active-branch"],
    ["POST", "/api/bots/bot_123/tasks"],
    ["POST", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/tasks/th_1"],
    ["DELETE", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/pin"],
    ["PATCH", "/api/bots/bot_123/profile"],
    ["PATCH", "/api/bots/bot_123/model"],
    ["POST", "/api/bots/bot_123/avatar/generate"],
    ["POST", "/api/bots/bot_123/computer/join"],
    ["GET", "/api/bots/bot_123/local-computer"],
    ["POST", "/api/bots/bot_123/local-computer/run"],
    ["POST", "/api/bots/bot_123/local-computer/stop"],
    ["POST", "/api/bots/bot_123/local-computer/recreate"],
    ["POST", "/api/groups/room-1/messages"],
    ["POST", "/api/groups/room-1/interrupt"],
    ["POST", "/api/groups/room-1/read"],
    ["PATCH", "/api/groups/room-1/pin"],
    ["GET", "/api/threads/th_1/messages"],
    ["GET", "/api/threads/th_1/messages/msg_2/image"],
    ["POST", "/api/threads/th_1/messages/msg_2/reactions"],
    ["GET", "/api/threads/th_1/export"],
    ["POST", "/api/threads/th_1/respond"],
    ["GET", "/api/search"],
    ["POST", "/api/attachments"],
    ["GET", "/api/attachments/avatar-123.webp"],
    ["GET", "/api/tts/voices"],
    ["POST", "/api/tts/speak"],
    ["GET", "/api/routines"],
    ["POST", "/api/routines"],
    ["PATCH", "/api/routines/routine_1"],
    ["DELETE", "/api/routines/routine_1"],
    ["POST", "/api/routines/routine_1/run"],
    ["GET", "/api/connectors/catalog"],
    ["GET", "/api/connectors/connected"],
    ["GET", "/api/connectors"],
    ["POST", "/api/connectors/slack/authorize"],
    ["GET", "/api/bots/bot_123/connector-cards/msg_2/status"],
    ["POST", "/api/bots/bot_123/connector-cards/msg_2/authorize"],
    ["POST", "/api/bots/bot_123/connector-cards/msg_2/resume"],
    ["POST", "/api/bots/bot_123/connector-cards/msg_2/dismiss"],
  ];

  for (const [method, path] of calls) {
    it(`allows ${method} ${path}`, () => expect(ask(method, path)).toBeNull());
  }
});

describe("what it may not", () => {
  it("refuses host configuration, and says where it happens", () => {
    for (const [method, path] of [
      ["PUT", "/api/config"],
      ["PATCH", "/api/config"],
      ["GET", "/api/devices"],
      ["GET", "/api/companion"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/webhooks/wh_1/rotate"],
      ["DELETE", "/api/connectors/gmail"],
      ["POST", "/api/teams/import"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial?.status, `${method} ${path}`).toBe(403);
      expect(denial?.error, `${method} ${path}`).toMatch(/on your computer/);
    }
  });

  it("keeps endpoint refresh authenticated and exact-method only", () => {
    expect(ask("GET", "/api/companion/endpoints", false)?.status).toBe(401);
    expect(ask("GET", "/api/companion/endpoints")).toBeNull();
    expect(ask("POST", "/api/companion/endpoints")?.status).toBe(403);
    expect(ask("GET", "/api/companion/endpoints/extra")?.status).toBe(403);
  });

  it("describes only refused routine operations as computer-only", () => {
    for (const [method, path] of [
      ["GET", "/api/routines/routine_1"],
      ["PUT", "/api/routines/routine_1"],
      ["POST", "/api/routines/routine_1/cancel"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial, `${method} ${path}`).toEqual({
        status: 403,
        error: "this routine operation is only available on your computer",
      });
    }
    expect(ask("GET", "/api/routines")).toBeNull();
    expect(ask("POST", "/api/routines/routine_1/run")).toBeNull();
  });

  it("denies the peer-agent endpoints exist at all", () => {
    expect(ask("GET", "/api/internal/peers")?.status).toBe(404);
    expect(ask("POST", "/api/internal/ask-bot")?.status).toBe(404);
  });

  it("does not expose reconstructed Grok Bot loopback routes", () => {
    for (const [method, path] of [
      ["GET", "/health"],
      ["GET", "/events"],
      ["POST", "/api/listAgents"],
      ["POST", "/api/sendPrompt"],
      ["POST", "/api/getAgentTranscriptTail"],
      ["GET", "/api/grok-reconstructed"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial?.status, `${method} ${path}`).toBe(404);
    }
  });

  it("does not serve the desktop UI", () => {
    expect(ask("GET", "/")?.status).toBe(404);
    expect(ask("GET", "/index.html")?.status).toBe(404);
  });

  it("opens only a fresh cloud viewer, not the cloud computer control API", () => {
    expect(allowed("POST", "/api/bots/bot_123/computer/join")).toBe(true);
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/provision")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/sleep")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/exec")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/screenshot")).toBe(false);
  });

  it("opens only per-bot Local VM status and guarded actions", () => {
    expect(allowed("GET", "/api/bots/bot_123/local-computer")).toBe(true);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/run")).toBe(true);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/stop")).toBe(true);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/recreate")).toBe(true);
    expect(allowed("POST", "/api/local-computer/run")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/start")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/remove")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/screenshot")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/local-computer/run/extra")).toBe(false);
  });

  it("requires an empty JSON object for Local VM actions", () => {
    const path = "/api/bots/bot_123/local-computer/run";
    expect(validateLocalVmActionBody("POST", path, {})).toBeNull();
    expect(validateLocalVmActionBody("POST", path, { command: "rm -rf /" })).toMatchObject({ status: 400 });
    expect(validateLocalVmActionBody("POST", path, [])).toMatchObject({ status: 400 });
    expect(validateLocalVmActionBody("GET", path, { ignored: true })).toBeNull();
  });

  // The method is part of the allowance, not decoration: reading the fleet
  // and deleting a bot are the same path.
  it("allows a path only for the methods it was allowed for", () => {
    expect(allowed("GET", "/api/bots")).toBe(true);
    expect(allowed("DELETE", "/api/bots/bot_123")).toBe(false);
    expect(allowed("POST", "/api/threads/th_1/messages")).toBe(false);
    expect(allowed("GET", "/api/groups/room-1")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/model")).toBe(true);
    expect(allowed("PUT", "/api/bots/bot_123/model")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/model/extra")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/profile/execution-policy")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
    expect(allowed("GET", "/api/attachments/../config.json")).toBe(false);
    expect(allowed("POST", "/api/routine-runs/run_1/cancel")).toBe(false);
    expect(allowed("DELETE", "/api/connectors/slack")).toBe(false);
    expect(allowed("GET", "/api/connectors/connected/all")).toBe(false);
    // revocation is a Mac-only affordance: the phone can list and add
    // accounts but the account DELETE route is deliberately not allowed
    expect(allowed("DELETE", "/api/connectors/slack/accounts/ca_123")).toBe(false);
    expect(allowed("GET", "/api/bots/bot_123/connector-cards/msg_2/authorize")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/connector-cards/msg_2/status")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/connector-cards/msg_2/authorize/extra")).toBe(false);
    expect(allowed("PATCH", "/api/groups/room-1")).toBe(false);
    expect(allowed("POST", "/api/groups/room-1/interrupt")).toBe(true);
    expect(allowed("PATCH", "/api/groups/room-1/interrupt")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/pin/extra")).toBe(false);
    expect(allowed("PATCH", "/api/groups/room-1/pin/extra")).toBe(false);
  });

  // Patterns are anchored, so a path that merely starts right is still a
  // path nobody allowed.
  it("is not fooled by a prefix", () => {
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("GET", "/api/botsandthensome")).toBe(false);
    expect(allowed("GET", "/api/events/all")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_2/image/../../../config")).toBe(false);
    expect(allowed("GET", "/api/bots%2f..%2fwebhooks")).toBe(false);
  });

  it("validates connector-card mutation bodies without accepting secret fields", () => {
    const path = "/api/bots/bot_123/connector-cards/msg_2/authorize";
    expect(validateConnectorCardBody("POST", path, { threadId: "thread_1" })).toBeNull();
    expect(validateConnectorCardBody("POST", path, {})).toMatchObject({ status: 400 });
    expect(validateConnectorCardBody("POST", path, { threadId: "thread_1", alias: "Work" })).toMatchObject({ status: 400 });
    expect(validateConnectorCardBody("POST", path, { threadId: "thread_1", apiKey: "secret" })).toMatchObject({ status: 400 });
    expect(validateConnectorCardBody("POST", path, { threadId: "thread/1" })).toMatchObject({ status: 400 });
    expect(validateConnectorCardBody("GET", path, { threadId: "thread_1" })).toBeNull();
  });

  it("validates connector-card status thread identifiers", () => {
    expect(validateConnectorCardThreadId("thread_1")).toBeNull();
    expect(validateConnectorCardThreadId("thread/1")?.status).toBe(400);
    expect(validateConnectorCardThreadId("")?.status).toBe(400);
    expect(validateConnectorCardThreadId({ secret: "nope" })?.status).toBe(400);
  });

  // The one that matters. Upstream adds routes on its own schedule, and the
  // sidecar must not carry them to a phone because nobody wrote a rule
  // against a thing that did not exist yet.
  it("denies a route it has never heard of", () => {
    for (const path of [
      "/api/whatever-ships-next",
      "/api/bots/bot_123/some-new-verb",
      "/api/secrets",
    ]) {
      expect(allowed("GET", path), path).toBe(false);
      expect(allowed("POST", path), path).toBe(false);
      expect(allowed("DELETE", path), path).toBe(false);
    }
  });
});
