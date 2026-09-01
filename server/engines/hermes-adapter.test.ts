import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HermesBotAdapter,
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
    expect(await discover).toMatchObject({
      state: "available",
      version: "0.21.0",
      profiles: [{ profile: "default", handle: "hermes" }],
    });
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

  it("projects an exact hidden Bot Chat, resumes the resolved id, streams deltas, and completes once", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: unknown[] = [];
    engine.onEvent((event) => events.push(event));
    const send = engine.send({ profile: "coder", text: "hello", threadId: "thread-1", turnId: "turn-1" });
    await settle();
    ready(child);
    await settle();
    for (const raw of child.stdin.writes) {
      const req = JSON.parse(raw);
      if (req.method === "session.list") {
        expect(req.params).toEqual({ profile: "coder", title: "Bot Chat", include_hidden: true, limit: 200 });
        child.frame({ jsonrpc: "2.0", id: req.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", hidden: true, source: "tui", message_count: 4 }] } });
      }
    }
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

  it("distinguishes absent canonical chats from unknown lookup failures and does not create sessions", async () => {
    const { child } = harness();
    const engine = createHermesBotEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const absent = engine.lookupCanonical("coder");
    await settle();
    ready(child);
    await settle();
    const request = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: request.id, result: { sessions: [] } });
    await expect(absent).resolves.toEqual({ state: "absent" });
    const send = engine.send({ profile: "coder", text: "never", threadId: "t", turnId: "u" });
    await settle();
    const retryLookup = JSON.parse(child.stdin.writes.at(-1)!);
    expect(retryLookup.method).toBe("session.list");
    child.frame({ jsonrpc: "2.0", id: retryLookup.id, result: { sessions: [] } });
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
});

describe("Hermes child environment", () => {
  it("retains ordinary Hermes variables but strips all V Bot secret-shaped names", () => {
    expect(sanitizeHermesChildEnv({
      VBOT_API_KEY: "x",
      OPENMAUSBOT_TOKEN: "y",
      HERMES_HOME: "/tmp/hermes",
      OPENROUTER_API_KEY: "z",
    }, {})).toEqual({ HERMES_HOME: "/tmp/hermes", OPENROUTER_API_KEY: "z" });
  });
});
