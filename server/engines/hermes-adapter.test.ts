import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HermesBotAdapter,
  HermesGatewayClient,
  createHermesBotEngine,
  sanitizeHermesChildEnv,
  type HermesProcess,
  type HermesSpawn,
} from "./hermes.ts";
import type { RuntimeEvent } from "../contracts.ts";

class FakeStream extends EventEmitter {
  setEncoding(): void {
    // The adapter is allowed to request UTF-8 decoding from real streams.
  }
}

class FakeProcess extends EventEmitter implements HermesProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin = {
    writable: true,
    writes: [] as string[],
    write: (chunk: string) => {
      this.stdin.writes.push(chunk);
      this.onRequest?.(JSON.parse(chunk));
      return true;
    },
    end: vi.fn(),
    on: vi.fn(),
  };
  onRequest?: (request: { id: number; method: string; params: Record<string, unknown> }) => void;
  kill = vi.fn(() => true);

  frame(value: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(value)}\n`);
  }

  close(code = 0): void {
    this.emit("close", code, null);
  }
}

function ready(process: FakeProcess, version = "0.21.0"): void {
  process.frame({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { version, path: "/private" } },
  });
}

function harness() {
  const child = new FakeProcess();
  const spawn = vi.fn<HermesSpawn>(() => child);
  return { child, spawn };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => vi.useRealTimers());

describe("Hermes Bot Chat loopback transport", () => {
  it("uses --tui, strips V Bot credentials, waits for gateway.ready, and correlates RPC ids", async () => {
    const { child, spawn } = harness();
    const engine = createHermesBotEngine({
      cli: "/opt/hermes",
      cwd: "/work",
      environment: {
        V_BOT_TOKEN: "must-not-cross",
        OPENMAUSBOT_SECRET: "must-not-cross",
        HERMES_HOME: "/private/hermes",
      },
      spawn,
    });
    const discover = engine.discover();
    await settle();
    ready(child);
    await settle();
    const request = JSON.parse(child.stdin.writes[0]!);
    expect(request.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "status.update", payload: { text: "ignored" } } });
    child.frame({ jsonrpc: "2.0", id: request.id, result: { profiles: [{ name: "default", is_default: true }] } });
    const discoveryResult = await discover;
    expect(discoveryResult).toMatchObject({
      state: "available",
      version: "0.21.0",
      profiles: [{ profile: "default", handle: "hermes" }],
    });
    expect(discoveryResult.authenticated).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/opt/hermes",
      ["--tui"],
      expect.objectContaining({ cwd: "/work", stdio: ["pipe", "pipe", "pipe"] }),
    );
    const env = spawn.mock.calls[0]?.[2]?.env;
    expect(env.V_BOT_TOKEN).toBeUndefined();
    expect(env.OPENMAUSBOT_SECRET).toBeUndefined();
    expect(env.HERMES_HOME).toBe("/private/hermes");
    await engine.close();
  });

  it("fails startup when the gateway closes before ready instead of waiting for the init timeout", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({
      spawn: vi.fn<HermesSpawn>(() => child),
      timeouts: { initializationMs: 1_000 },
    });
    const discover = engine.discover();
    await settle();
    child.close(1);
    await expect(discover).resolves.toMatchObject({
      state: "unavailable",
      reason: "gateway_unavailable",
    });
    await engine.close();
  });

  it.each(["ENOENT", "EACCES"])("maps an asynchronous child %s error to fixed missing_cli diagnostics", async (code) => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn<HermesSpawn>(() => child) });
    const discovery = engine.discover();
    await settle();
    child.emit("error", Object.assign(new Error("/private/hermes/bin/hermes"), { code }));
    const result = await discovery;
    expect(result).toMatchObject({ state: "unavailable", reason: "missing_cli" });
    expect(JSON.stringify(result)).not.toContain("/private/hermes");
    await engine.close();
  });

  it("projects an exact hidden Bot Chat, resumes the resolved id, streams deltas, and completes once", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: unknown[] = [];
    engine.onEvent((event) => events.push(event));
    const send = engine.send({ profile: "coder", text: "hello", threadId: "thread-1", turnId: "turn-1" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(roster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    expect(list.method).toBe("session.list");
    expect(list.params).toEqual({ profile: "coder", title: "Bot Chat", include_hidden: true, limit: 200 });
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", hidden: true, source: "tui", message_count: 4 }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    expect(resume.method).toBe("session.resume");
    expect(resume.params).toEqual({ profile: "coder", session_id: "tip" });
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-only", session_key: "also-runtime-only" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    expect(prompt.method).toBe("prompt.submit");
    expect(prompt.params).toEqual({ session_id: "runtime-only", text: "hello" });
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    expect(await send).toEqual({ turnId: "turn-1" });
    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "message.start", session_id: "runtime-only" } });
    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "runtime-only", payload: { text: "hel" } } });
    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "runtime-only", payload: { text: "hello", status: "complete", usage: { input: 2, output: 1 } } } });
    await Promise.resolve();
    expect((events as Array<{ type: string }>).map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 2, output: 1 } });
    expect(JSON.stringify(events)).not.toContain("runtime-only");
    await engine.close();
  });

  it.each([
    ["alias-first", "hermes", "default"],
    ["canonical-first", "default", "hermes"],
  ])("serializes concurrent default/alias sends ($0) without overwriting the runtime", async (_label, firstProfile, secondProfile) => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));

    const first = engine.send({ profile: firstProfile, text: "first", threadId: "t-first", turnId: "turn-first" });
    const second = engine.send({ profile: secondProfile, text: "second", threadId: "t-second", turnId: "turn-second" });
    await settle();
    ready(child);
    await settle();

    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(roster.method).toBe("profiles.list");
    expect(child.stdin.writes).toHaveLength(1);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "default", is_default: true }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    expect(list.method).toBe("session.list");
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    expect(resume.method).toBe("session.resume");
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "ephemeral-runtime" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    expect(prompt.method).toBe("prompt.submit");
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });

    await expect(first).resolves.toEqual({ turnId: "turn-first" });
    await expect(second).rejects.toMatchObject({ code: "upstream_error" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).toEqual([
      "profiles.list", "session.list", "session.resume", "prompt.submit",
    ]);

    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "ephemeral-runtime", payload: { text: "still running" } } });
    await settle();
    const interrupt = engine.interrupt(secondProfile, "turn-first");
    await settle();
    const interruptRequest = JSON.parse(child.stdin.writes.at(-1)!);
    expect(interruptRequest.method).toBe("session.interrupt");
    expect(interruptRequest.params).toEqual({ session_id: "ephemeral-runtime" });
    child.frame({ jsonrpc: "2.0", id: interruptRequest.id, result: { status: "interrupted" } });
    await expect(interrupt).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "content.delta")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    await engine.close();
  });

  it("distinguishes absent canonical chats from unknown lookup failures and does not create sessions", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const absent = engine.lookupCanonical("coder");
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const request = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: request.id, result: { sessions: [] } });
    await expect(absent).resolves.toEqual({ state: "absent" });
    const send = engine.send({ profile: "coder", text: "never", threadId: "t", turnId: "u" });
    await settle();
    const retryLookup = JSON.parse(child.stdin.writes.at(-1)!);
    expect(retryLookup.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: retryLookup.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const retrySessionLookup = JSON.parse(child.stdin.writes.at(-1)!);
    expect(retrySessionLookup.method).toBe("session.list");
    child.frame({ jsonrpc: "2.0", id: retrySessionLookup.id, result: { sessions: [] } });
    await expect(send).rejects.toMatchObject({ code: "profile_unavailable" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("session.create");
    await engine.close();
  });

  it("maps interrupt to one cancellation terminal and clears the runtime", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
    const send = engine.send({ profile: "coder", text: "wait", threadId: "t", turnId: "turn" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: {} });
    await send;
    const interrupted = engine.interrupt("coder", "turn");
    await settle();
    const rpc = JSON.parse(child.stdin.writes.at(-1)!);
    expect(rpc.method).toBe("session.interrupt");
    child.frame({ jsonrpc: "2.0", id: rpc.id, result: { status: "interrupted" } });
    await interrupted;
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "interrupted" });
    await expect(engine.interrupt("coder", "turn")).resolves.toBeUndefined();
    await engine.close();
  });

  it.each([
    {
      label: "ambiguity",
      expectedState: "available",
      response: { profiles: [{ name: "default", is_default: true }, { name: "default", is_default: true }] },
    },
    {
      label: "deletion",
      expectedState: "available",
      response: { profiles: [{ name: "other" }] },
    },
    {
      label: "unavailability",
      expectedState: "unavailable",
      response: { profiles: [], success: false },
    },
  ])("keeps a runtime started through the hermes alias interruptible after roster $label", async ({ expectedState, response }) => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));

    const send = engine.send({ profile: "hermes", text: "wait", threadId: "t", turnId: "turn" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(roster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "default", is_default: true }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "ephemeral-runtime-secret" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;

    const refresh = engine.discover();
    await settle();
    const refreshRequest = JSON.parse(child.stdin.writes.at(-1)!);
    expect(refreshRequest.method).toBe("profiles.list");
    child.frame({
      jsonrpc: "2.0",
      id: refreshRequest.id,
      result: response,
    });
    await expect(refresh).resolves.toMatchObject({ state: expectedState });

    const interrupt = engine.interrupt("hermes", "turn");
    await settle();
    const interruptRequest = JSON.parse(child.stdin.writes.at(-1)!);
    expect(interruptRequest.method).toBe("session.interrupt");
    expect(interruptRequest.params).toEqual({ session_id: "ephemeral-runtime-secret" });
    child.frame({ jsonrpc: "2.0", id: interruptRequest.id, result: { status: "interrupted" } });
    await expect(interrupt).resolves.toBeUndefined();
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("ephemeral-runtime-secret");
    await engine.close();
  });

  it("requires a fresh, unique discovered profile before canonical lookup", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const lookup = engine.lookupCanonical("deleted");
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "other" }] } });
    await expect(lookup).resolves.toMatchObject({ state: "unknown", code: "profile_unavailable" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("session.list");
    await engine.close();
  });

  it("refuses ambiguous handles and retains no guessed default session", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const send = engine.send({ profile: "hermes", text: "do not guess", threadId: "t", turnId: "u" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({
      jsonrpc: "2.0",
      id: roster.id,
      result: { profiles: [{ name: "default", is_default: true }, { name: "hermes" }] },
    });
    await expect(send).rejects.toMatchObject({ code: "profile_unavailable" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("session.list");
    await engine.close();
  });

  it("requires the ephemeral session_id and never falls back to session_key", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const send = engine.send({ profile: "coder", text: "hello", threadId: "t", turnId: "u" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_key: "durable-only" } });
    await expect(send).rejects.toMatchObject({ code: "malformed_response" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("prompt.submit");
    await engine.close();
  });

  it("maps an empty final text to a safe malformed terminal without guessed content", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
    const send = engine.send({ profile: "coder", text: "prompt with /private path", threadId: "t", turnId: "u" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "runtime", payload: { text: "", status: "complete" } } });
    await settle();
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "malformed_response" });
    expect(JSON.stringify(events)).not.toContain("/private");
    await engine.close();
  });

  it("classifies authentication errors without exposing their message", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const discovery = engine.discover();
    await settle();
    ready(child);
    await settle();
    const request = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: request.id, error: { code: 401, message: "token=/private/provider-secret" } });
    await expect(discovery).resolves.toMatchObject({ state: "unavailable", reason: "invalid_credentials", capabilities: { roster: false } });
    await engine.close();
  });

  it.each([
    ["401", "string"],
    [1.5, "fractional"],
  ])("fails closed when JSON-RPC error.code is not an integer ($1)", async (code, _label) => {
    const { child } = harness();
    const client = new HermesGatewayClient({
      cli: "hermes",
      environment: {},
      spawn: vi.fn(() => child),
      clock: { now: Date.now, setTimeout, clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      timeouts: { initializationMs: 500, requestMs: 500, turnMs: 500, reconnectMs: 500 },
      onEvent: vi.fn(),
      onState: vi.fn(),
    });
    const started = client.start();
    await settle();
    ready(child);
    await started;
    const request = client.request("profiles.list", {});
    await settle();
    const rpc = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: rpc.id, error: { code, message: "/private/provider-secret" } });
    await expect(request).rejects.toMatchObject({ code: "malformed_response" });
    await client.close();
  });

  it("marks a nonzero child exit unavailable and rejects pending calls", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 500 } });
    const discovery = engine.discover();
    await settle();
    ready(child);
    await settle();
    const request = JSON.parse(child.stdin.writes.at(-1)!);
    child.close(17);
    await expect(discovery).resolves.toMatchObject({ state: "unavailable", reason: "gateway_unavailable" });
    expect(request.method).toBe("profiles.list");
    await engine.close();
  });

  it("reconnects explicitly and repeats exact roster/session lookup on the new generation", async () => {
    const firstChild = new FakeProcess();
    const secondChild = new FakeProcess();
    const spawn = vi.fn<HermesSpawn>()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const engine = createHermesBotEngine({ spawn, timeouts: { requestMs: 100, turnMs: 500, reconnectMs: 500 } });

    const first = engine.discover();
    await settle();
    ready(firstChild);
    await settle();
    const firstRoster = JSON.parse(firstChild.stdin.writes.at(-1)!);
    firstChild.frame({ jsonrpc: "2.0", id: firstRoster.id, result: { profiles: [{ name: "coder" }] } });
    await first;
    firstChild.close(9);
    await settle();

    const reconnect = engine.reconnect();
    await settle();
    ready(secondChild);
    await expect(reconnect).resolves.toBeUndefined();

    const send = engine.send({ profile: "coder", text: "again", threadId: "t", turnId: "u" });
    await settle();
    const secondRoster = JSON.parse(secondChild.stdin.writes.at(-1)!);
    expect(secondRoster.method).toBe("profiles.list");
    secondChild.frame({ jsonrpc: "2.0", id: secondRoster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(secondChild.stdin.writes.at(-1)!);
    expect(list.method).toBe("session.list");
    secondChild.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(secondChild.stdin.writes.at(-1)!);
    secondChild.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-new" } });
    await settle();
    const prompt = JSON.parse(secondChild.stdin.writes.at(-1)!);
    secondChild.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    secondChild.frame({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "runtime-new", payload: { text: "ok", status: "complete" } } });
    await settle();
    expect(secondChild.stdin.writes.map((raw) => JSON.parse(raw).method)).toEqual([
      "profiles.list", "session.list", "session.resume", "prompt.submit",
    ]);
    await engine.close();
  });

  it("demotes capabilities and marks a previous roster stale on a roster RPC error", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const first = engine.discover();
    await settle();
    ready(child);
    await settle();
    const firstRequest = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: firstRequest.id, result: { profiles: [{ name: "coder" }] } });
    await expect(first).resolves.toMatchObject({ state: "available", profiles: [{ availability: "available" }] });
    expect(engine.capabilities.roster).toBe(true);

    const second = engine.discover();
    await settle();
    const secondRequest = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: secondRequest.id, error: { code: 5006, message: "/private/state.db?prompt=secret" } });
    await expect(second).resolves.toMatchObject({ state: "unavailable", profiles: [{ availability: "unavailable" }] });
    expect(engine.capabilities).toMatchObject({ roster: false, canonicalChat: false, send: false, finalResponse: false, events: false, stop: false });
    await engine.close();
  });

  it("fails closed for malformed JSON-RPC envelopes and events", async () => {
    const malformedFrames = [
      { jsonrpc: "1.0", method: "event", params: { type: "gateway.ready", payload: {} } },
      { jsonrpc: "2.0", method: "event", id: 1, params: { type: "gateway.ready", payload: {} } },
      { jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "s", payload: "not-an-object" } },
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1 } },
      { jsonrpc: "2.0", id: "one", result: {} },
    ];
    for (const frame of malformedFrames) {
      const { child } = harness();
      const client = new HermesGatewayClient({
        cli: "hermes",
        environment: {},
        spawn: vi.fn(() => child),
        clock: { now: Date.now, setTimeout, clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
        timeouts: { initializationMs: 500, requestMs: 500, turnMs: 500, reconnectMs: 500 },
        onEvent: vi.fn(),
        onState: vi.fn(),
      });
      const started = client.start();
      await settle();
      child.frame(frame);
      await expect(started).rejects.toMatchObject({ code: "malformed_response" });
      await client.close();
    }
  });
});

describe("Hermes gateway protocol ordering and timeouts", () => {
  function directClient(child: FakeProcess, initializationMs = 500): HermesGatewayClient {
    return new HermesGatewayClient({
      cli: "hermes",
      environment: {},
      spawn: vi.fn(() => child),
      clock: { now: Date.now, setTimeout, clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      timeouts: { initializationMs, requestMs: 500, turnMs: 500, reconnectMs: 500 },
      onEvent: vi.fn(),
      onState: vi.fn(),
    });
  }

  it("correlates out-of-order responses without crossing pending calls", async () => {
    const { child } = harness();
    const client = directClient(child);
    const first = client.request("profiles.list", {});
    const second = client.request("session.list", {});
    await settle();
    ready(child);
    await settle();
    const requests = child.stdin.writes.map((raw) => JSON.parse(raw));
    expect(requests.map((request) => request.method)).toEqual(["profiles.list", "session.list"]);
    child.frame({ jsonrpc: "2.0", id: requests[1].id, result: { second: true } });
    child.frame({ jsonrpc: "2.0", id: requests[0].id, result: { first: true } });
    await expect(first).resolves.toEqual({ first: true });
    await expect(second).resolves.toEqual({ second: true });
    await client.close();
  });

  it("resolves synchronous gateway.ready emitted while listeners attach", async () => {
    const { child } = harness();
    const originalOn = child.stdout.on.bind(child.stdout);
    child.stdout.on = ((event: string, listener: (...args: any[]) => void) => {
      const result = originalOn(event, listener);
      if (event === "data") ready(child);
      return result;
    }) as typeof child.stdout.on;
    const client = directClient(child, 100);
    await expect(client.start()).resolves.toBeUndefined();
    expect(client.isReady).toBe(true);
    await client.close();
  });

  it("accepts the pinned gateway's nested skin ready payload without forwarding it", async () => {
    const { child } = harness();
    const client = directClient(child);
    const started = client.start();
    await settle();
    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "gateway.ready", payload: { skin: { name: "dark", colors: { red: "#fff" } }, path: "/secret" } },
    });
    await started;
    expect(client.payload).toEqual({});
    await client.close();
  });

  it("times out a pending request and rejects all pending calls on close", async () => {
    vi.useRealTimers();
    const { child } = harness();
    const client = directClient(child);
    const started = client.start();
    await settle();
    ready(child);
    await started;
    const timeout = client.request("profiles.list", {}, 10);
    await expect(timeout).rejects.toMatchObject({ code: "timeout" });

    const pending = client.request("profiles.list", {}, 500);
    await Promise.resolve();
    child.close(7);
    await expect(pending).rejects.toMatchObject({ code: "gateway_unavailable" });
    await client.close();
  });
});

describe("Hermes child environment", () => {
  it("retains only the positive Hermes runtime allowlist", () => {
    expect(sanitizeHermesChildEnv({
      VBOT_API_KEY: "x",
      OPENMAUSBOT_TOKEN: "y",
      HERMES_HOME: "/tmp/hermes",
      OPENROUTER_API_KEY: "z",
      OPENAI_API_KEY: "z",
      ANTHROPIC_API_KEY: "z",
      XAI_API_KEY: "z",
      AWS_ACCESS_KEY_ID: "z",
      WORKSPACE_TOKEN: "z",
      PROVIDER_KEY: "z",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
    }, {})).toEqual({
      HERMES_HOME: "/tmp/hermes",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
    });
  });
});
