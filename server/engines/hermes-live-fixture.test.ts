#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setHermesBinding } from "./bindings.ts";
import { createHermesBotEngine, type HermesBotAdapter } from "./hermes.ts";
import { createHermesEngineRegistry } from "./index.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { openSse } from "../testing/sse.ts";

const ENGINES_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(ENGINES_DIR, "..");
const ROOT = join(SERVER_DIR, "..");
const FIXTURE_SOURCE = join(SERVER_DIR, "testing", "fake-hermes-tui-gateway.ts");
const DOCS_HERMES = join(ROOT, "docs", "hermes-adapter.md");
const DOCS_ARCH = join(ROOT, "docs", "v-bot-architecture.md");
const PORT = 29_000 + Math.floor(Math.random() * 4_000);
const WEBHOOK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

const PROFILE = "default";
const SESSION_ROOT = "session-root";
const SESSION_TIP = "session-tip";
const FIXTURE_REPLY = "fixture Hermes wave1 reply";
const SECRET_MARKERS = [
  SESSION_ROOT,
  SESSION_TIP,
  "runtime-gen-",
  "session-root",
  "session-tip",
  "profile-path",
  "state.db",
  "fixture/secret",
  "must-not-leak",
];

function writeFixtureLauncher(home: string): string {
  const launcher = join(home, "fake-hermes-launcher.cjs");
  writeFileSync(
    launcher,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fixture = ${JSON.stringify(FIXTURE_SOURCE)};
const child = spawn(process.execPath, ["--experimental-strip-types", fixture, ...process.argv.slice(2)], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
process.stdin.on("data", (chunk) => child.stdin.write(chunk));
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`,
    { mode: 0o700 },
  );
  return launcher;
}

function fixtureEnv(home: string, hermesHome: string): Record<string, string> {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    HOME: home,
    USERPROFILE: home,
    HERMES_HOME: hermesHome,
  };
}

function setFixtureMode(hermesHome: string, mode: string): void {
  writeFileSync(join(hermesHome, "fixture-mode"), mode);
}

function enableFixtureDeltas(hermesHome: string): void {
  writeFileSync(join(hermesHome, "fixture-deltas"), "1");
}

function clearFixtureControls(hermesHome: string): void {
  for (const name of ["fixture-mode", "fixture-deltas", "mode-control.txt", "rpc.ndjson"]) {
    const path = join(hermesHome, name);
    if (existsSync(path)) writeFileSync(path, "");
  }
  writeFileSync(join(hermesHome, "fixture-mode"), "happy");
}

async function settle(ms = 30): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function readRpcLog(path: string): Array<{ method: string; params: Record<string, unknown> }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertNoSecrets(payload: string, extras: string[] = []): void {
  for (const marker of [...SECRET_MARKERS, ...extras]) {
    expect(payload).not.toContain(marker);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate: () => Promise<boolean>, message: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await settle(50);
  }
}

describe("Hermes live loopback fixture", () => {
  describe("documentation release gate", () => {
    it("documents Bot Chat identity, include_hidden, fail-closed behavior, pairing separation, and deferrals", () => {
      expect(existsSync(DOCS_HERMES)).toBe(true);
      const hermesDoc = readFileSync(DOCS_HERMES, "utf8");
      const archDoc = readFileSync(DOCS_ARCH, "utf8");
      for (const needle of [
        "Bot Chat",
        "include_hidden",
        "pairing",
        "hermesBot",
        "VBotPrimaryEngine",
        "message_agent",
        "deferral",
        "unknown",
        "unavailable",
      ]) {
        expect(hermesDoc.toLowerCase()).toContain(needle.toLowerCase());
      }
      expect(archDoc).toMatch(/Hermes Bot Mode|hermesBot/i);
      expect(archDoc.toLowerCase()).toContain("v bot store");
      expect(hermesDoc).not.toMatch(/CLI fallback|SessionDB path|account token/i);
    });
  });

  describe("adapter factory through deterministic child", () => {
    let home = "";
    let hermesHome = "";
    let launcher = "";
    let rpcLog = "";
    let engine: HermesBotAdapter;

    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), "vbot-hermes-live-adapter-"));
      hermesHome = join(home, "hermes-home");
      mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
      launcher = writeFixtureLauncher(home);
      rpcLog = join(hermesHome, "rpc.ndjson");
      setFixtureMode(hermesHome, "happy");
    });

    afterAll(async () => {
      await engine?.close();
      await removeTempDir(home);
    });

    afterEach(async () => {
      await engine?.close();
      clearFixtureControls(hermesHome);
    });

    it("launches the fixture, discovers the hermes handle, and redacts spawn output", async () => {
      enableFixtureDeltas(hermesHome);
      engine = createHermesBotEngine({
        cli: launcher,
        environment: fixtureEnv(home, hermesHome),
        timeouts: { initializationMs: 5_000, requestMs: 5_000, turnMs: 10_000, reconnectMs: 5_000 },
      }) as HermesBotAdapter;
      const discovery = await engine.discover();
      expect(discovery).toMatchObject({
        state: "available",
        profiles: [{ profile: PROFILE, handle: "hermes", availability: "available" }],
        capabilities: {
          roster: true,
          events: true,
          messageAgent: false,
          groups: false,
          queueing: false,
          steer: false,
          attachments: false,
          routinesRead: false,
          crossMachine: false,
        },
      });
      const dump = JSON.parse(readFileSync(join(hermesHome, "spawn-dump.json"), "utf8"));
      expect(dump.argv).toEqual(["--tui"]);
      expect(JSON.stringify(dump)).not.toContain("session-root");
      expect(JSON.stringify(dump)).not.toContain("session-tip");
      expect(JSON.stringify(dump)).not.toContain("must-not-leak");
    });

    it("streams a final answer without leaking durable or runtime ids", async () => {
      enableFixtureDeltas(hermesHome);
      engine = createHermesBotEngine({
        cli: launcher,
        environment: fixtureEnv(home, hermesHome),
        timeouts: { initializationMs: 5_000, requestMs: 5_000, turnMs: 10_000, reconnectMs: 5_000 },
      }) as HermesBotAdapter;
      const events: unknown[] = [];
      engine.onEvent((event) => events.push(event));
      await engine.discover();
      const send = engine.send({ profile: PROFILE, text: "hello fixture", threadId: "thread-live", turnId: "turn-live" });
      await settle(200);
      await send;
      await settle(100);
      expect(events.some((event) => (event as { type?: string }).type === "content.delta")).toBe(true);
      expect(events.some((event) =>
        (event as { type?: string; text?: string }).type === "item.completed"
        && (event as { text?: string }).text === FIXTURE_REPLY)).toBe(true);
      assertNoSecrets(JSON.stringify(events), ["hello fixture"]);
      const calls = readRpcLog(rpcLog);
      const resume = calls.find((entry) => entry.method === "session.resume");
      expect(resume?.params).toMatchObject({ session_id: SESSION_TIP });
    });

    it("interrupts a long fixture turn once", async () => {
      setFixtureMode(hermesHome, "hang");
      engine = createHermesBotEngine({
        cli: launcher,
        environment: fixtureEnv(home, hermesHome),
        timeouts: { initializationMs: 5_000, requestMs: 5_000, turnMs: 10_000, reconnectMs: 5_000 },
      }) as HermesBotAdapter;
      const events: unknown[] = [];
      engine.onEvent((event) => events.push(event));
      await engine.discover();
      void engine.send({ profile: PROFILE, text: "hold", threadId: "thread-hang", turnId: "turn-hang" });
      await settle(150);
      await engine.interrupt(PROFILE, "turn-hang");
      await settle(150);
      const completed = events.filter((event) => (event as { type?: string }).type === "turn.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ ok: false, stopReason: "interrupted" });
      assertNoSecrets(JSON.stringify(events), ["hold"]);
    });

    it("reconnects with a fresh title lookup and resumes the compression tip", async () => {
      engine = createHermesBotEngine({
        cli: launcher,
        environment: fixtureEnv(home, hermesHome),
        timeouts: { initializationMs: 5_000, requestMs: 5_000, turnMs: 10_000, reconnectMs: 5_000 },
      }) as HermesBotAdapter;
      await engine.discover();
      await engine.send({ profile: PROFILE, text: "before restart", threadId: "thread-a", turnId: "turn-a" });
      await settle(200);
      const beforeRestart = readRpcLog(rpcLog);
      const dump = JSON.parse(readFileSync(join(hermesHome, "spawn-dump.json"), "utf8"));
      process.kill(dump.pid, "SIGKILL");
      await settle(100);
      writeFileSync(rpcLog, "");
      await engine.reconnect();
      await engine.send({ profile: PROFILE, text: "after restart", threadId: "thread-b", turnId: "turn-b" });
      await settle(200);
      const afterRestart = readRpcLog(rpcLog);
      expect(afterRestart.filter((entry) => entry.method === "session.list")).toHaveLength(1);
      expect(afterRestart.find((entry) => entry.method === "session.list")?.params).toMatchObject({
        profile: PROFILE,
        title: "Bot Chat",
        include_hidden: true,
        limit: 200,
      });
      expect(afterRestart.find((entry) => entry.method === "session.resume")?.params).toMatchObject({
        session_id: SESSION_TIP,
      });
      expect(beforeRestart.filter((entry) => entry.method === "session.list")).toHaveLength(1);
      expect(afterRestart.filter((entry) => entry.method === "session.create")).toHaveLength(0);
    });

    it.each([
      ["malformed-final", "malformed_response"],
      ["auth-fail", "invalid_credentials"],
      ["rpc-timeout", "timeout"],
      ["missing-profile", "profile_unavailable"],
    ])("maps fixture mode %s to typed unavailable behavior", async (fixtureMode, code) => {
      setFixtureMode(hermesHome, fixtureMode);
      engine = createHermesBotEngine({
        cli: launcher,
        environment: fixtureEnv(home, hermesHome),
        timeouts: { initializationMs: 500, requestMs: 500, turnMs: 500, reconnectMs: 500 },
      }) as HermesBotAdapter;
      if (fixtureMode === "malformed-final") {
        await engine.discover();
        const events: unknown[] = [];
        engine.onEvent((event) => events.push(event));
        await engine.send({ profile: PROFILE, text: "bad final", threadId: "thread-bad", turnId: "turn-bad" });
        await settle(200);
        expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: false, stopReason: "malformed_response" });
        assertNoSecrets(JSON.stringify(events), ["bad final"]);
        return;
      }
      if (fixtureMode === "missing-profile") {
        const discovery = await engine.discover();
        expect(discovery.profiles).toEqual([]);
        await expect(engine.send({
          profile: PROFILE,
          text: "missing",
          threadId: "thread-missing",
          turnId: "turn-missing",
        })).rejects.toMatchObject({ code: "profile_unavailable" });
        return;
      }
      const discovery = await engine.discover();
      expect(discovery.state).toBe("unavailable");
      expect(discovery.reason).toBe(code);
      expect(discovery.capabilities.roster).toBe(false);
    });

    it("ignores global gateway events with empty session ids", async () => {
      engine = createHermesBotEngine({
        cli: launcher,
        environment: fixtureEnv(home, hermesHome),
        timeouts: { initializationMs: 5_000, requestMs: 5_000, turnMs: 10_000, reconnectMs: 5_000 },
      }) as HermesBotAdapter;
      const events: unknown[] = [];
      engine.onEvent((event) => events.push(event));
      await engine.discover();
      void engine.send({ profile: PROFILE, text: "global", threadId: "thread-global", turnId: "turn-global" });
      await settle(250);
      expect(events.filter((event) => (event as { type?: string }).type === "turn.completed")).toHaveLength(1);
    });

    it("uses the same factory path as the hub registry", async () => {
      const registry = createHermesEngineRegistry({
        enabled: true,
        instanceConfigs: {
          hermes: { driver: "hermesAgent", config: { cli: launcher }, environment: fixtureEnv(home, hermesHome) },
        },
        createEngine: (options) => createHermesBotEngine(options) as HermesBotAdapter,
      });
      const description = await registry.discover();
      expect(description.state).toBe("available");
      expect(description.profiles[0]?.handle).toBe("hermes");
      await registry.disposeAll();
    });
  });

  describe("hub integration through live fixture", () => {
    let child: ChildProcess;
    let home = "";
    let dataDir = "";
    let hermesHome = "";
    let launcher = "";
    let rpcLog = "";
    let stderr = "";
    let bindingPath = "";

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), "vbot-hermes-live-hub-"));
      dataDir = join(home, "data");
      hermesHome = join(home, "hermes-home");
      launcher = writeFixtureLauncher(home);
      rpcLog = join(hermesHome, "rpc.ndjson");
      bindingPath = join(dataDir, "hermes-bindings.json");
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
      setFixtureMode(hermesHome, "happy");
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({
        vbot: { hermes: { enabled: true } },
        instances: { hermes: { driver: "hermesAgent", config: { cli: launcher } } },
      }));

      child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
        cwd: ROOT,
        env: {
          ...fixtureEnv(home, hermesHome),
          OMB_DATA_DIR: dataDir,
          OMB_PORT: String(PORT),
          OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });

      const deadline = Date.now() + 25_000;
      for (;;) {
        try {
          if ((await fetch(`${BASE}/api/health`)).ok) break;
        } catch {
          // still booting
        }
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
        if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
        await settle(100);
      }
    }, 40_000);

    afterAll(async () => {
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(home);
    });

    it("projects safe roster, SSE/API messages, interrupt, restart lookup, and fail-closed bindings", async () => {
      const sse = await openSse(`${BASE}/api/events`);
      try {
        await sse.until((frame) => frame.kind === "hello");
        const instances = await api("GET", "/api/instances");
        expect(instances.status).toBe(200);
        const hermes = instances.body.instances.find((entry: { instanceId?: string }) => entry.instanceId === "hermes");
        expect(hermes?.capabilities?.hermesBot?.state).toBe("available");
        expect(hermes?.capabilities?.hermesBot?.capabilities?.messageAgent).toBe(false);
        assertNoSecrets(JSON.stringify(instances.body));

        const created = await api("POST", "/api/bots");
        expect(created.status).toBe(201);
        const bot = created.body.bot;
        const bindingBefore = JSON.stringify({
          version: 1,
          bindings: {
            [bot.id]: {
              adapter: "hermesBot",
              profile: PROFILE,
              canonicalTitle: "Bot Chat",
              bindingVersion: 1,
            },
          },
        });
        writeFileSync(bindingPath, bindingBefore, { mode: 0o600 });

        const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello Hermes live" });
        expect(sent.status).toBe(202);
        await waitFor(async () => {
          const current = await api("GET", "/api/bots");
          const found = current.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
          return found?.busy === false && found?.messages?.some((message: { role: string; text?: string }) =>
            message.role === "bot" && message.text === FIXTURE_REPLY);
        }, "assistant message in /api/bots");
        await sse.until((frame) => frame.kind === "message" && frame.message?.role === "bot" && frame.message?.text === FIXTURE_REPLY);
        const settled = await api("GET", "/api/bots");
        const settledBot = settled.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
        assertNoSecrets(JSON.stringify(settledBot));
        expect(readFileSync(bindingPath, "utf8")).toBe(bindingBefore);

        writeFileSync(join(hermesHome, "mode-control.txt"), "hang");
        const hang = await api("POST", `/api/bots/${bot.id}/messages`, { text: "stay running" });
        expect(hang.status).toBe(202);
        await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy === true, "busy hang turn", 20_000);
        expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
        await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy === false, "interrupted turn");
        const interruptedEvents = sse.frames.filter((frame) =>
          frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event?.stopReason === "interrupted");
        expect(interruptedEvents.length).toBeGreaterThan(0);

        writeFileSync(rpcLog, "");
        writeFileSync(join(hermesHome, "mode-control.txt"), "happy");
        await api("PATCH", "/api/config", { vbot: { hermes: { enabled: true } } });
        await settle(300);
        const afterRestart = await api("POST", `/api/bots/${bot.id}/messages`, { text: "after gateway restart" });
        expect(afterRestart.status).toBe(202);
        await waitFor(async () => {
          const current = await api("GET", "/api/bots");
          const found = current.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
          return found?.messages?.filter((message: { role: string; text?: string }) =>
            message.role === "bot" && message.text === FIXTURE_REPLY).length >= 2;
        }, "post-restart assistant message");
        const restartCalls = readRpcLog(rpcLog);
        expect(restartCalls.some((entry) => entry.method === "session.list" && entry.params?.title === "Bot Chat")).toBe(true);
        expect(restartCalls.some((entry) => entry.method === "session.resume" && entry.params?.session_id === SESSION_TIP)).toBe(true);
        expect(readFileSync(bindingPath, "utf8")).toBe(bindingBefore);

        writeFileSync(bindingPath, "{not-json", { mode: 0o600 });
        const malformedBot = (await api("POST", "/api/bots")).body.bot;
        expect((await api("POST", `/api/bots/${malformedBot.id}/messages`, { text: "must fail closed" })).status).toBe(202);
        await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === malformedBot.id)?.busy === false, "malformed binding failure");
        const malformed = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === malformedBot.id);
        expect(malformed.activity).toBe("dead");
        expect(malformed.messages.some((message: { role: string; text?: string }) => message.role === "bot" && message.text === FIXTURE_REPLY)).toBe(false);
        expect((await api("POST", `/api/bots/${malformedBot.id}/interrupt`)).status).toBe(409);
        assertNoSecrets(JSON.stringify(malformed));
      } finally {
        sse.close();
      }
    }, 60_000);
  });

  describe("fail-closed binding store with live registry", () => {
    it("does not mutate bindings on unavailable writes", () => {
      const file = join(mkdtempSync(join(tmpdir(), "vbot-hermes-bindings-")), "hermes-bindings.json");
      writeFileSync(file, JSON.stringify({
        version: 1,
        bindings: {
          bot1: { adapter: "hermesBot", profile: PROFILE, canonicalTitle: "Bot Chat", bindingVersion: 1 },
        },
      }), { mode: 0o600 });
      const before = readFileSync(file, "utf8");
      const result = setHermesBinding("bot2", {
        adapter: "hermesBot",
        profile: "../escape",
        canonicalTitle: "Bot Chat",
        bindingVersion: 1,
      }, file);
      expect(result.state).toBe("unavailable");
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });
});
