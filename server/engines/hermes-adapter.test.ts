import { EventEmitter } from "node:events";

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  HermesBotAdapter,
  HermesGatewayClient,
  createHermesBotEngine,
  sanitizeHermesChildEnv,
  type HermesProcess,
  type HermesSpawn,
} from "./hermes.ts";
import { HermesCommBudget } from "./hermes-comms.ts";
import type { RuntimeEvent } from "../contracts.ts";

let gatewayRoot = "";

beforeAll(() => {
  gatewayRoot = mkdtempSync(join(tmpdir(), "vbot-hermes-adapter-gateway-"));
  mkdirSync(join(gatewayRoot, "tui_gateway"), { recursive: true });
  writeFileSync(join(gatewayRoot, "tui_gateway", "entry.py"), "# marker\n");
});

afterAll(() => {
  if (gatewayRoot) rmSync(gatewayRoot, { recursive: true, force: true });
});

function gatewayEnvironment(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HERMES_PYTHON_SRC_ROOT: gatewayRoot,
    HERMES_PYTHON: "/opt/hermes-venv/bin/python3",
    ...extra,
  };
}

function createTestHermesEngine(options: Parameters<typeof createHermesBotEngine>[0] = {}) {
  return createHermesBotEngine({
    cli: "/opt/hermes/bin/hermes",
    ...options,
    environment: gatewayEnvironment(options.environment),
  });
}

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
      const request = JSON.parse(chunk) as { id: number; method: string; params: Record<string, unknown> };
      if (request.method === "gateway.capabilities") {
        if (this.protocolMode === "legacy") {
          this.frame({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } });
          return true;
        }
        if (this.capabilitiesMode === "auto") {
          this.frame({ jsonrpc: "2.0", id: request.id, result: { per_session_exclusive_submit: true } });
        } else if (this.capabilitiesMode === "omit") {
          this.frame({ jsonrpc: "2.0", id: request.id, result: {} });
        }
        return true;
      }
      if (request.method === "groups.capabilities") {
        if (this.protocolMode === "legacy") {
          this.frame({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } });
          return true;
        }
        this.frame({ jsonrpc: "2.0", id: request.id, result: { authority_epoch: 1 } });
        return true;
      }
      if (request.method === "profiles.list") {
        if (this.protocolMode === "legacy") {
          this.frame({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } });
          return true;
        }
      }
      if (request.method === "setup.status") {
        this.frame({ jsonrpc: "2.0", id: request.id, result: { provider_configured: true } });
        return true;
      }
      if (request.method === "cli.exec") {
        this.frame({ jsonrpc: "2.0", id: request.id, result: { blocked: false, code: 0, output: "0.10.0-fixture\n" } });
        return true;
      }
      this.onRequest?.(request);
      return true;
    },
    end: vi.fn(),
    on: vi.fn(),
  };
  capabilitiesMode: "auto" | "manual" | "omit" = "auto";
  protocolMode: "modern" | "legacy" = "modern";
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
  it("launches the python gateway module, strips V Bot credentials, waits for gateway.ready, and correlates RPC ids", async () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "vbot-hermes-adapter-root-"));
    mkdirSync(join(fakeRoot, "tui_gateway"), { recursive: true });
    writeFileSync(join(fakeRoot, "tui_gateway", "entry.py"), "# marker\n");
    const { child, spawn } = harness();
    const engine = createTestHermesEngine({
      cli: "/opt/hermes/bin/hermes",
      cwd: "/work",
      environment: {
        V_BOT_TOKEN: "must-not-cross",
        OPENMAUSBOT_SECRET: "must-not-cross",
        HERMES_HOME: "/private/hermes",
        HERMES_PYTHON_SRC_ROOT: fakeRoot,
        HERMES_PYTHON: "/opt/hermes-venv/bin/python3",
      },
      spawn,
    });
    const discover = engine.discover();
    await settle();
    ready(child);
    await settle();
    const capabilities = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "gateway.capabilities")!);
    expect(capabilities.params).toEqual({});
    const request = JSON.parse(child.stdin.writes.at(-1)!);
    expect(request.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", method: "event", params: { type: "status.update", payload: { text: "ignored" } } });
    child.frame({ jsonrpc: "2.0", id: request.id, result: { profiles: [{ name: "default", is_default: true }] } });
    const discoveryResult = await discover;
    expect(discoveryResult).toMatchObject({
      state: "available",
      version: "0.21.0",
      profiles: [{ profile: "default", handle: "hermes" }],
      capabilities: { exclusiveSubmit: true },
    });
    expect(discoveryResult.authenticated).not.toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "/opt/hermes-venv/bin/python3",
      ["-m", "tui_gateway.entry"],
      expect.objectContaining({ cwd: "/work", stdio: ["pipe", "pipe", "pipe"] }),
    );
    const env = spawn.mock.calls[0]?.[2]?.env;
    expect(env.V_BOT_TOKEN).toBeUndefined();
    expect(env.OPENMAUSBOT_SECRET).toBeUndefined();
    expect(env.HERMES_HOME).toBe("/private/hermes");
    await engine.close();
  });

  it("falls back to Hermes 0.10 setup.status when profiles.list is missing", async () => {
    const child = new FakeProcess();
    child.protocolMode = "legacy";
    const engine = createTestHermesEngine({ spawn: () => child });
    const discover = engine.discover();
    await settle();
    ready(child);
    await settle();
    const methods = child.stdin.writes.map((raw) => JSON.parse(raw).method);
    expect(methods).toContain("gateway.capabilities");
    expect(methods).toContain("profiles.list");
    expect(methods).toContain("setup.status");
    expect(methods).toContain("session.list");
    const setup = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "setup.status")!);
    child.frame({ jsonrpc: "2.0", id: setup.id, result: { provider_configured: true } });
    await settle();
    const version = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "cli.exec")!);
    child.frame({ jsonrpc: "2.0", id: version.id, result: { blocked: false, code: 0, output: "0.10.0-fixture\n" } });
    await settle();
    const list = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "session.list")!);
    expect(list.params).toEqual({ limit: 200 });
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [] } });
    const discovery = await discover;
    expect(discovery).toMatchObject({
      state: "available",
      version: "0.10.0-fixture",
      profiles: [{ profile: "default", handle: "hermes", canonicalChat: "absent" }],
      capabilities: { roster: true, exclusiveSubmit: false, canonicalChat: false },
    });
    await engine.close();
  });

  it("projects legacy discovery canonicalChat present after Bot Chat exists", async () => {
    const child = new FakeProcess();
    child.protocolMode = "legacy";
    const engine = createTestHermesEngine({ spawn: () => child });
    const discover = engine.discover();
    await settle();
    ready(child);
    await settle();
    const setup = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "setup.status")!);
    child.frame({ jsonrpc: "2.0", id: setup.id, result: { provider_configured: true } });
    await settle();
    const version = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "cli.exec")!);
    child.frame({ jsonrpc: "2.0", id: version.id, result: { blocked: false, code: 0, output: "0.10.0-fixture\n" } });
    await settle();
    const list = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "session.list")!);
    expect(list.params).toEqual({ limit: 200 });
    child.frame({
      jsonrpc: "2.0",
      id: list.id,
      result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] },
    });
    const discovery = await discover;
    expect(discovery).toMatchObject({
      state: "available",
      profiles: [{ profile: "default", handle: "hermes", canonicalChat: "present" }],
      capabilities: { roster: true, canonicalChat: true, send: false },
    });
    await engine.close();
  });

  it("calls gateway.capabilities after gateway.ready and refuses exclusiveSubmit when omitted", async () => {
    const child = new FakeProcess();
    child.capabilitiesMode = "omit";
    const engine = createTestHermesEngine({ spawn: () => child });
    const discover = engine.discover();
    await settle();
    ready(child);
    await settle();
    const caps = JSON.parse(child.stdin.writes.find((raw) => JSON.parse(raw).method === "gateway.capabilities")!);
    expect(caps.params).toEqual({});
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(roster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "default" }] } });
    const discovery = await discover;
    expect(discovery.capabilities.exclusiveSubmit).toBe(false);
    await engine.close();
  });

  it("fails startup when the gateway closes before ready instead of waiting for the init timeout", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({
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
    const engine = createTestHermesEngine({ spawn: vi.fn<HermesSpawn>(() => child) });
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
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
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
      "session.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(events[1]).toMatchObject({ type: "session.started", sessionId: null });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 2, output: 1 } });
    expect(JSON.stringify(events)).not.toContain("runtime-only");
    await engine.close();
  });

  it("accepts empty session ids on global watcher events without ending an active runtime", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));

    const send = engine.send({ profile: "coder", text: "hello", threadId: "thread-global", turnId: "turn-global" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder", is_default: false }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-global" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;

    for (const type of ["skin.changed", "status.update", "session.info", "sessions.changed"]) {
      child.frame({ jsonrpc: "2.0", method: "event", params: { type, session_id: "", payload: {} } });
    }
    await settle();
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(0);

    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.complete", session_id: "runtime-global", payload: { text: "done", status: "complete" } },
    });
    await settle();
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    await engine.close();
  });

  it.each([
    ["alias-first", "hermes", "default"],
    ["canonical-first", "default", "hermes"],
  ])("serializes concurrent default/alias sends ($0) without overwriting the runtime", async (_label, firstProfile, secondProfile) => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));

    const first = engine.send({ profile: firstProfile, text: "first", threadId: "t-first", turnId: "turn-first" });
    const second = engine.send({ profile: secondProfile, text: "second", threadId: "t-second", turnId: "turn-second" });
    await settle();
    ready(child);
    await settle();

    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(roster.method).toBe("profiles.list");
    expect(child.stdin.writes).toHaveLength(3);
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
      "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.resume", "prompt.submit",
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

  it("distinguishes absent canonical chats from unknown lookup failures without minting on lookup alone", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
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
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("session.create");
    await engine.close();
  });

  it("mints Bot Chat only after a successful empty hidden lookup, then re-resolves", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const send = engine.send({ profile: "coder", text: "hello", threadId: "thr", turnId: "turn-1" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list1 = JSON.parse(child.stdin.writes.at(-1)!);
    expect(list1.method).toBe("session.list");
    expect(list1.params).toEqual({ profile: "coder", title: "Bot Chat", include_hidden: true, limit: 200 });
    child.frame({ jsonrpc: "2.0", id: list1.id, result: { sessions: [] } });
    await settle();
    const mintRoster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(mintRoster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: mintRoster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const created = JSON.parse(child.stdin.writes.at(-1)!);
    expect(created.method).toBe("session.create");
    expect(created.params).toEqual({ profile: "coder", title: "Bot Chat", hidden: true, source: "tui" });
    child.frame({ jsonrpc: "2.0", id: created.id, result: { session_id: "rt-new" } });
    await settle();
    const refreshRoster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: refreshRoster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list2 = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({
      jsonrpc: "2.0",
      id: list2.id,
      result: {
        sessions: [{
          id: "root-new",
          resolved_id: "tip-new",
          title: "Bot Chat",
          hidden: true,
          source: "tui",
        }],
      },
    });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    expect(resume.params.session_id).toBe("tip-new");
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "rt-live" } });
    await settle();
    const submit = JSON.parse(child.stdin.writes.at(-1)!);
    expect(submit.params.session_id).toBe("rt-live");
    child.frame({ jsonrpc: "2.0", id: submit.id, result: { ok: true } });
    await send;
    expect(engine.capabilities.adoptMint).toBe(true);
    await engine.close();
  });

  it("does not mint when hidden lookup fails", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const send = engine.send({ profile: "coder", text: "hello", threadId: "t", turnId: "u" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, error: { code: 500, message: "lookup failed" } });
    await expect(send).rejects.toMatchObject({ code: "state_unavailable" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("session.create");
    await engine.close();
  });

  it("does not mint a second chat when post-create lookup is unknown", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const send = engine.send({ profile: "coder", text: "hello", threadId: "t", turnId: "u" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list1 = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list1.id, result: { sessions: [] } });
    await settle();
    const mintRoster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: mintRoster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const create = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: create.id, result: { session_id: "rt-new" } });
    await settle();
    const refreshRoster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(refreshRoster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: refreshRoster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list2 = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list2.id, error: { code: 500, message: "broken" } });
    await expect(send).rejects.toMatchObject({ code: "state_unavailable" });
    expect(child.stdin.writes.filter((raw) => JSON.parse(raw).method === "session.create")).toHaveLength(1);
    await engine.close();
  });

  it("adopts before minting a missing Bot Chat and confirms the created row", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const ensure = engine.ensureCanonical("coder");
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(roster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const firstList = JSON.parse(child.stdin.writes.at(-1)!);
    expect(firstList.method).toBe("session.list");
    child.frame({ jsonrpc: "2.0", id: firstList.id, result: { sessions: [] } });
    await settle();
    const create = JSON.parse(child.stdin.writes.at(-1)!);
    expect(create.method).toBe("session.create");
    expect(create.params).toEqual({ profile: "coder", title: "Bot Chat", hidden: true, source: "tui" });
    child.frame({ jsonrpc: "2.0", id: create.id, result: { session_id: "new-runtime" } });
    await settle();
    const refreshedRoster = JSON.parse(child.stdin.writes.at(-1)!);
    expect(refreshedRoster.method).toBe("profiles.list");
    child.frame({ jsonrpc: "2.0", id: refreshedRoster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const secondList = JSON.parse(child.stdin.writes.at(-1)!);
    expect(secondList.method).toBe("session.list");
    child.frame({
      jsonrpc: "2.0",
      id: secondList.id,
      result: { sessions: [{ id: "root-new", resolved_id: "tip-new", title: "Bot Chat", hidden: true, source: "tui" }] },
    });
    await expect(ensure).resolves.toMatchObject({ profile: "coder", title: "Bot Chat", resolvedSessionId: "tip-new" });
    await engine.close();
  });

  it.each([
    ["upstream rejection", { code: 500 }, "upstream_error"],
    ["credential rejection", { code: 401 }, "invalid_credentials"],
  ])("clears the pending marker after a definitive session.create %s so retry may create", async (_label, rpcError, expectedCode) => {
    const pendingDir = mkdtempSync(join(tmpdir(), "hermes-pending-"));
    const pendingPath = join(pendingDir, "pending.json");
    const { child } = harness();
    const engine = new HermesBotAdapter({
      environment: gatewayEnvironment(),
      spawn: vi.fn(() => child),
      pendingPath,
      timeouts: { requestMs: 100 },
    });
    try {
      const first = engine.ensureCanonical("coder");
      await settle();
      ready(child);
      await settle();
      const firstRoster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: firstRoster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const firstList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: firstList.id, result: { sessions: [] } });
      await settle();
      const firstCreate = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: firstCreate.id, error: rpcError });
      await expect(first).rejects.toMatchObject({ code: expectedCode });
      expect(existsSync(pendingPath)).toBe(false);

      const retry = engine.ensureCanonical("coder");
      await settle();
      const retryRoster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: retryRoster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const retryList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: retryList.id, result: { sessions: [] } });
      await settle();
      const retryCreate = JSON.parse(child.stdin.writes.at(-1)!);
      expect(retryCreate.method).toBe("session.create");
      child.frame({ jsonrpc: "2.0", id: retryCreate.id, result: { session_id: "created-after-rejection" } });
      await settle();
      const refreshedRoster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: refreshedRoster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const refreshedList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({
        jsonrpc: "2.0",
        id: refreshedList.id,
        result: { sessions: [{ id: "root-created", title: "Bot Chat", source: "tui" }] },
      });
      await expect(retry).resolves.toMatchObject({ profile: "coder" });
      expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).toEqual([
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.create",
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.create",
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list",
      ]);
    } finally {
      await engine.close();
      rmSync(pendingDir, { recursive: true, force: true });
    }
  });

  it("canonicalizes the direct hermes alias to default before marker and create", async () => {
    const pendingDir = mkdtempSync(join(tmpdir(), "hermes-pending-"));
    const pendingPath = join(pendingDir, "pending.json");
    const { child } = harness();
    const engine = new HermesBotAdapter({
      environment: gatewayEnvironment(),
      spawn: vi.fn(() => child),
      pendingPath,
      timeouts: { requestMs: 100 },
    });
    try {
      const ensure = engine.ensureCanonical("hermes");
      await settle();
      ready(child);
      await settle();
      const roster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "default", is_default: true }] } });
      await settle();
      const list = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [] } });
      await settle();
      const create = JSON.parse(child.stdin.writes.at(-1)!);
      expect(create.method).toBe("session.create");
      expect(create.params.profile).toBe("default");
      expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual({ version: 1, profiles: ["default"] });
      child.frame({ jsonrpc: "2.0", id: create.id, result: { session_id: "created-default" } });
      await settle();
      const refreshedRoster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: refreshedRoster.id, result: { profiles: [{ name: "default", is_default: true }] } });
      await settle();
      const refreshedList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({
        jsonrpc: "2.0",
        id: refreshedList.id,
        result: { sessions: [{ id: "root-default", title: "Bot Chat", source: "tui" }] },
      });
      await expect(ensure).resolves.toMatchObject({ profile: "default" });
      expect(existsSync(pendingPath)).toBe(false);
    } finally {
      await engine.close();
      rmSync(pendingDir, { recursive: true, force: true });
    }
  });

  it("persists a profile-only pending marker when post-create lookup is absent and never mints again", async () => {
    const pendingDir = mkdtempSync(join(tmpdir(), "hermes-pending-"));
    const pendingPath = join(pendingDir, "pending.json");
    const { child } = harness();
    const engine = new HermesBotAdapter({
      environment: gatewayEnvironment(),
      spawn: vi.fn(() => child),
      pendingPath,
      timeouts: { requestMs: 100 },
    });
    try {
      const ensure = engine.ensureCanonical("coder");
      await settle();
      ready(child);
      await settle();
      const roster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const firstList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: firstList.id, result: { sessions: [] } });
      await settle();
      const create = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: create.id, result: { session_id: "durable-created" } });
      await settle();
      const refreshedRoster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: refreshedRoster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const secondList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: secondList.id, result: { sessions: [] } });
      await expect(ensure).rejects.toMatchObject({ code: "malformed_response" });

      expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toEqual({ version: 1, profiles: ["coder"] });
      const retry = engine.ensureCanonical("coder");
      await settle();
      const retryRoster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: retryRoster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const retryList = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: retryList.id, result: { sessions: [] } });
      await expect(retry).rejects.toMatchObject({ code: "state_unavailable" });
      expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).toEqual([
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.create",
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list",
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list",
      ]);
      expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).not.toContain("session.delete");
      expect(readFileSync(pendingPath, "utf8")).not.toContain("durable-created");
    } finally {
      await engine.close();
      rmSync(pendingDir, { recursive: true, force: true });
    }
  });

  it.each([
    [{ id: "id-only" }, "id-only field"],
    [{ session_id: " durable-id " }, "whitespace-padded id"],
    [{ session_id: "" }, "empty id"],
  ])("requires the exact strict durable session_id shape ($1)", async (created, _label) => {
    const pendingDir = mkdtempSync(join(tmpdir(), "hermes-pending-"));
    const { child } = harness();
    const engine = new HermesBotAdapter({
      environment: gatewayEnvironment(),
      spawn: vi.fn(() => child),
      pendingPath: join(pendingDir, "pending.json"),
      timeouts: { requestMs: 100 },
    });
    try {
      const ensure = engine.ensureCanonical("coder");
      await settle();
      ready(child);
      await settle();
      const roster = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
      await settle();
      const list = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [] } });
      await settle();
      const create = JSON.parse(child.stdin.writes.at(-1)!);
      child.frame({ jsonrpc: "2.0", id: create.id, result: created });
      await expect(ensure).rejects.toMatchObject({ code: "malformed_response" });
      expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).toEqual([
        "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.create",
      ]);
    } finally {
      await engine.close();
      rmSync(pendingDir, { recursive: true, force: true });
    }
  });

  it("fails closed when session.create does not return a durable id", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
    const ensure = engine.ensureCanonical("coder");
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [] } });
    await settle();
    const create = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: create.id, result: {} });
    await expect(ensure).rejects.toMatchObject({ code: "malformed_response" });
    expect(child.stdin.writes.map((raw) => JSON.parse(raw).method)).toEqual([
      "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.create",
    ]);
    await engine.close();
  });

  it("maps interrupt to one cancellation terminal and clears the runtime", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
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
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
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
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
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
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
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
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
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
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
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

  it("accepts message.complete with status=error and null text as a safe upstream failure", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
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
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-auth-fail" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.complete", session_id: "runtime-auth-fail", payload: { text: null, status: "error" } },
    });
    await settle();
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(0);
    expect(events.filter((event) => event.type === "runtime.error")).toEqual([
      expect.objectContaining({ type: "runtime.error", message: "Hermes request failed" }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "upstream_error" });
    await engine.close();
  });

  it("still rejects message.complete with status=complete and null text as malformed", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
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
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-null-success" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.complete", session_id: "runtime-null-success", payload: { text: null, status: "complete" } },
    });
    await settle();
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "malformed_response" });
    await engine.close();
  });

  it("discards provider diagnostic text on error complete without leaking secrets", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
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
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-diag" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "runtime-diag",
        payload: { text: "provider auth failed: sk-secret-openai-key-abc123", status: "error" },
      },
    });
    await settle();
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "upstream_error" });
    expect(JSON.stringify(events)).not.toContain("sk-secret");
    expect(JSON.stringify(events)).not.toContain("openai-key");
    await engine.close();
  });

  it("emits one safe runtime error before one terminal event for an upstream prompt failure", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
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
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-error" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, error: { code: 5000, message: "/private/provider secret" } });
    await expect(send).rejects.toMatchObject({ code: "upstream_error" });
    await settle();
    const runtimeErrors = events.filter((event) => event.type === "runtime.error");
    const completed = events.filter((event) => event.type === "turn.completed");
    expect(runtimeErrors).toHaveLength(1);
    expect(runtimeErrors[0]).toMatchObject({ message: "Hermes request failed" });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "upstream_error" });
    expect(JSON.stringify(events)).not.toContain("private");
    await engine.close();
  });

  it("classifies an active turn timeout as transient runtime work", async () => {
    const { child } = harness();
    const timers: Array<{ timeout: number; handler: () => void }> = [];
    const clock = {
      now: () => 0,
      setTimeout: (handler: () => void, timeout: number) => {
        const timer = { timeout, handler };
        timers.push(timer);
        return timer;
      },
      clearTimeout: vi.fn(),
    };
    const engine = new HermesBotAdapter({
      environment: gatewayEnvironment(),
      spawn: vi.fn(() => child),
      clock,
      timeouts: { requestMs: 100, turnMs: 20 },
    });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));

    const send = engine.send({ profile: "coder", text: "wait", threadId: "t", turnId: "u" });
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
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-timeout" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;

    const turnTimer = timers.find((timer) => timer.timeout === 20);
    expect(turnTimer).toBeDefined();
    turnTimer!.handler();
    expect(events.at(-2)).toMatchObject({
      type: "runtime.error",
      message: "Hermes request timed out",
      setup: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "timeout" });
    expect(JSON.stringify(events)).not.toContain("runtime-timeout");
    await engine.close();
  });

  it("classifies authentication errors without exposing their message", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
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
      cli: "/opt/hermes/bin/hermes",
      environment: gatewayEnvironment(),
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
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 500 } });
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
    const engine = createTestHermesEngine({ spawn, timeouts: { requestMs: 100, turnMs: 500, reconnectMs: 500 } });

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
      "gateway.capabilities", "groups.capabilities", "profiles.list", "session.list", "session.resume", "prompt.submit",
    ]);
    await engine.close();
  });

  it("demotes capabilities and marks a previous roster stale on a roster RPC error", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100 } });
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

  it("answers through approval.respond with once|deny", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const send = engine.send({ profile: "coder", text: "run", threadId: "t", turnId: "turn-a" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-approval" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    const approval = engine.respondToApproval({ profile: "coder", requestId: "req-1", choice: "allow" });
    await settle();
    const rpc = JSON.parse(child.stdin.writes.at(-1)!);
    expect(rpc.method).toBe("approval.respond");
    expect(rpc.params.choice).toBe("once");
    expect(rpc.params.request_id).toBe("req-1");
    child.frame({ jsonrpc: "2.0", id: rpc.id, result: { ok: true } });
    await approval;
    await engine.close();
  });

  it("denies through approval.respond with deny", async () => {
    const { child } = harness();
    const engine = createTestHermesEngine({ spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const send = engine.send({ profile: "coder", text: "run", threadId: "t", turnId: "turn-deny" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-deny" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    const approval = engine.respondToApproval({ profile: "coder", requestId: "req-deny", choice: "deny" });
    await settle();
    const rpc = JSON.parse(child.stdin.writes.at(-1)!);
    expect(rpc.method).toBe("approval.respond");
    expect(rpc.params.choice).toBe("deny");
    child.frame({ jsonrpc: "2.0", id: rpc.id, result: { ok: true } });
    await approval;
    await engine.close();
  });

  it("records groupsProtocolSeen without enabling groups capability", async () => {
    const { child, spawn } = harness();
    const engine = createTestHermesEngine({ spawn });
    const discover = engine.discover();
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "default" }] } });
    await discover;
    expect(engine.adapterMemory.groupsProtocolSeen).toBe(true);
    expect(engine.capabilities.groups).toBe(false);
    await engine.close();
  });

  it("projects request.opened without paths or tokens in the summary", async () => {
    const { child } = harness();
    const engine = new HermesBotAdapter({ environment: gatewayEnvironment(), spawn: vi.fn(() => child), timeouts: { requestMs: 100, turnMs: 500 } });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
    const send = engine.send({ profile: "coder", text: "run", threadId: "t", turnId: "turn-opened" });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: "runtime-opened" } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "approval.pending",
        session_id: "runtime-opened",
        payload: {
          request_id: "req-opened",
          tool: "shell",
          summary: "rm -rf /private/hermes/state.db",
          command: "Bearer sk-secret-token",
        },
      },
    });
    await settle();
    const opened = events.find((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", requestId: "req-opened" });
    expect(JSON.stringify(opened)).not.toMatch(/private|Bearer|sk-secret|state\.db/i);
    await engine.close();
  });

  async function startRuntime(
    engine: HermesBotAdapter,
    child: FakeProcess,
    turnId: string,
  ): Promise<string> {
    const send = engine.send({ profile: "coder", text: "ping", threadId: "t-comm", turnId });
    await settle();
    ready(child);
    await settle();
    const roster = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: roster.id, result: { profiles: [{ name: "coder" }] } });
    await settle();
    const list = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: list.id, result: { sessions: [{ id: "root", resolved_id: "tip", title: "Bot Chat", source: "tui" }] } });
    await settle();
    const resume = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: resume.id, result: { session_id: `runtime-${turnId}` } });
    await settle();
    const prompt = JSON.parse(child.stdin.writes.at(-1)!);
    child.frame({ jsonrpc: "2.0", id: prompt.id, result: { accepted: true } });
    await send;
    return `runtime-${turnId}`;
  }

  function emitMessageAgent(child: FakeProcess, runtimeId: string, eventType: "tool.start" | "tool.complete"): void {
    const payload = {
      name: "message_agent",
      arguments: { target: "researcher", message: "ship it" },
      ...(eventType === "tool.complete" ? { ok: true, status: "complete" } : {}),
    };
    child.frame({
      jsonrpc: "2.0",
      method: "event",
      params: { type: eventType, session_id: runtimeId, payload },
    });
  }

  it("delivers message_agent comm once across start and complete without burning budget on replay skip", async () => {
    const { child } = harness();
    const budget = new HermesCommBudget(1);
    const delivered: unknown[] = [];
    const engine = new HermesBotAdapter({
      environment: gatewayEnvironment(),
      spawn: vi.fn(() => child),
      timeouts: { requestMs: 100, turnMs: 500 },
      handleToBotId: new Map([["researcher", "bot-b"]]),
      fromBotId: "bot-a",
      senderHandle: "coder",
      onComm: (candidate) => delivered.push(candidate),
      commBudget: budget,
    });
    const events: RuntimeEvent[] = [];
    engine.onEvent((event) => events.push(event));
    const runtimeId = await startRuntime(engine, child, "comm-once");
    emitMessageAgent(child, runtimeId, "tool.start");
    emitMessageAgent(child, runtimeId, "tool.complete");
    emitMessageAgent(child, runtimeId, "tool.start");
    await settle();
    expect(delivered).toHaveLength(1);
    expect(events.filter((event) =>
      event.type === "item.completed"
      && event.itemType === "tool"
      && event.title === "too many teammate messages",
    )).toHaveLength(0);
    expect(events.filter((event) => event.type === "item.started" && event.title === "message_agent")).toHaveLength(1);
    expect(events.filter((event) =>
      event.type === "item.completed"
      && event.itemType === "tool"
      && event.title === "message_agent",
    )).toHaveLength(1);
    await engine.close();
  });

  it("fails closed for malformed JSON-RPC envelopes and events", async () => {
    const malformedFrames = [
      { jsonrpc: "1.0", method: "event", params: { type: "gateway.ready", payload: {} } },
      { jsonrpc: "2.0", method: "event", id: 1, params: { type: "gateway.ready", payload: {} } },
      { jsonrpc: "2.0", method: "event", params: { type: "message.start", session_id: "" } },
      { jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "s", payload: "not-an-object" } },
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1 } },
      { jsonrpc: "2.0", id: "one", result: {} },
    ];
    for (const frame of malformedFrames) {
      const { child } = harness();
      const client = new HermesGatewayClient({
        cli: "/opt/hermes/bin/hermes",
        environment: gatewayEnvironment(),
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
      cli: "/opt/hermes/bin/hermes",
      environment: gatewayEnvironment(),
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
      LC_SECRET: "must-not-cross",
      LC_API_KEY: "must-not-cross",
    }, {})).toEqual({
      HERMES_HOME: "/tmp/hermes",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      TERM: "xterm",
    });
  });

  it("keeps arbitrary LC_* secrets out of the child environment", () => {
    expect(sanitizeHermesChildEnv({ LC_SECRET: "x", LC_API_KEY: "y", LC_CTYPE: "C" }, {})).toEqual({ LC_CTYPE: "C" });
  });
});
