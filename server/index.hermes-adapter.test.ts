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

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 28_000 + Math.floor(Math.random() * 5_000);
const WEBHOOK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

// This child is deliberately a tiny protocol fixture, not a Hermes source
// checkout. It exercises the adapter's public gateway seam and keeps the
// integration test independent of any account, profile store, or credentials.
const FAKE_HERMES_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.HERMES_HOME ? process.env.HERMES_HOME + "/requests.ndjson" : null;
const writeLog = (value) => { if (log) fs.appendFileSync(log, JSON.stringify(value) + "\\n"); };
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.argv[2] === "--version") { process.stdout.write("0.21.0 (fixture)\\n"); process.exit(0); }
const args = process.argv.slice(2);
if (!(args.length === 0 || (args[0] === "-m" && args[1] === "tui_gateway.entry") || args[0] === "--tui")) { process.exit(2); }
let prompts = 0;
setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { version: "0.21.0" } } }), 20);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    writeLog(request);
    if (request.method === "gateway.capabilities") {
      out({ jsonrpc: "2.0", id: request.id, result: { per_session_exclusive_submit: true } });
    } else if (request.method === "groups.capabilities") {
      out({ jsonrpc: "2.0", id: request.id, result: { authority_epoch: 1 } });
    } else if (request.method === "profiles.list") {
      out({ jsonrpc: "2.0", id: request.id, result: { profiles: [{ name: "default", is_default: true, display_name: "Hermes fixture" }] } });
    } else if (request.method === "session.list") {
      out({ jsonrpc: "2.0", id: request.id, result: { sessions: [{ id: "root-session", resolved_id: "resolved-session", title: "Bot Chat", hidden: true, source: "tui", message_count: 1 }] } });
    } else if (request.method === "session.resume") {
      out({ jsonrpc: "2.0", id: request.id, result: { session_id: "runtime-only-session" } });
    } else if (request.method === "prompt.submit") {
      prompts += 1;
      out({ jsonrpc: "2.0", id: request.id, result: { accepted: true } });
      if (prompts === 1) setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "runtime-only-session", payload: { text: "fixture Hermes reply", status: "complete", usage: { input: 4, output: 2 } } } }), 40);
    } else if (request.method === "session.interrupt") {
      out({ jsonrpc: "2.0", id: request.id, result: { status: "interrupted" } });
      out({ jsonrpc: "2.0", method: "event", params: { type: "message.complete", session_id: "runtime-only-session", payload: { text: "interrupted", status: "interrupted" } } });
    }
  }
});
`;

let child: ChildProcess;
let home: string;
let dataDir: string;
let fakeHermes: string;
let hermesLog: string;
let hermesHome: string;
let stderr = "";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "vbot-hermes-index-"));
  dataDir = join(home, "data");
  fakeHermes = join(home, "fake-hermes.cjs");
  hermesHome = join(home, "hermes-home");
  hermesLog = join(hermesHome, "requests.ndjson");
  const fakeSrcRoot = join(home, "fake-hermes-src");
  mkdirSync(join(fakeSrcRoot, "tui_gateway"), { recursive: true });
  writeFileSync(join(fakeSrcRoot, "tui_gateway", "entry.py"), "# fixture marker\\n");
  const fakePython = join(home, "fake-python.cjs");
  writeFileSync(fakePython, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const gateway = ${JSON.stringify(fakeHermes)};
const args = process.argv.slice(2);
if (!(args[0] === "-m" && args[1] === "tui_gateway.entry")) process.exit(2);
const child = spawn(process.execPath, [gateway], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
process.stdin.on("data", (chunk) => child.stdin.write(chunk));
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`, { mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
  writeFileSync(fakeHermes, FAKE_HERMES_SOURCE, { mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    vbot: { hermes: { enabled: true } },
    instances: {
      hermes: {
        driver: "hermesAgent",
        config: { cli: fakeHermes },
        environment: {
          HERMES_PYTHON: fakePython,
          HERMES_PYTHON_SRC_ROOT: fakeSrcRoot,
        },
      },
    },
  }));

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_DATA_DIR: dataDir,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      HERMES_HOME: hermesHome,
      HERMES_PYTHON: fakePython,
      HERMES_PYTHON_SRC_ROOT: fakeSrcRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) break;
    } catch {
      // The server is still loading providers and the adapter discovery.
    }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("Hermes Bot Chat hub integration", () => {
  it("reports safe setup state and imports one profile idempotently", async () => {
    const ready = await api("GET", "/api/hermes/setup/status");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ state: "ready", profiles: [{ profile: "default", canonicalChat: "absent" }] });
    expect(JSON.stringify(ready.body)).not.toMatch(/session|runtime|root-session|resolved-session/i);

    const imported = await api("POST", "/api/hermes/setup", {});
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      created: true,
      profile: { profile: "default", botId: expect.any(String), canonicalChat: "present" },
      status: { state: "connected", capabilities: { canonicalChat: true } },
    });
    expect(JSON.stringify(imported.body)).not.toMatch(/session|runtime|root-session|resolved-session/i);

    const repeated = await api("POST", "/api/hermes/setup/connect", { profile: "DEFAULT" });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ created: false, botId: imported.body.botId });
    expect(JSON.stringify(repeated.body)).not.toMatch(/session|runtime|root-session|resolved-session/i);

    const secretSignIn = await api("POST", "/api/hermes/setup/signin", { token: "sk-secret" });
    expect(secretSignIn.status).toBe(400);
    expect(JSON.stringify(secretSignIn.body)).not.toMatch(/sk-secret|HERMES_HOME|token/i);

    const sidecar = JSON.parse(readFileSync(join(dataDir, "hermes-bindings.json"), "utf8")) as {
      version: number;
      bindings: Record<string, Record<string, unknown>>;
    };
    expect(sidecar).toEqual({
      version: 1,
      bindings: {
        [imported.body.botId]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    });

    const disabled = await api("PATCH", "/api/config", { vbot: { hermes: { enabled: false } } });
    expect(disabled.status).toBe(200);
    expect((await api("GET", "/api/hermes/setup")).body).toMatchObject({ state: "disabled", profiles: [] });
    const reenabled = await api("POST", "/api/hermes/setup", { profile: "default" });
    expect(reenabled.status).toBe(200);
    expect(reenabled.body).toMatchObject({ created: false, botId: imported.body.botId, status: { state: "connected" } });
  }, 30_000);

  it("dispatches a bound bot once, projects safe capabilities, and interrupts without a fallback", async () => {
    const instances = await api("GET", "/api/instances");
    expect(instances.status).toBe(200);
    const hermes = instances.body.instances.find((entry: { instanceId?: string }) => entry.instanceId === "hermes");
    expect(hermes).toMatchObject({
      instanceId: "hermes",
      capabilities: {
        computerMcp: false,
        localComputerMcp: false,
        hermesBot: {
          state: "available",
          capabilities: {
            roster: true,
            events: true,
            messageAgent: false,
            groups: false,
            queueing: false,
            steer: false,
          },
        },
      },
    });
    // Desktop instances retain their pre-existing CLI override for the
    // settings picker. The phone-facing catalog is the additive safe
    // projection and must not carry that path or any Hermes runtime id.
    expect(JSON.stringify(instances.body.providerCatalog)).not.toContain(fakeHermes);
    expect(JSON.stringify(instances.body.providerCatalog)).not.toContain("runtime-only-session");

    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect(bot.modelSelection.instanceId).toBe("hermes");

    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({
        version: 1,
        bindings: {
          [bot.id]: {
            adapter: "hermesBot",
            profile: "default",
            canonicalTitle: "Bot Chat",
            bindingVersion: 1,
          },
        },
      }),
      { mode: 0o600 },
    );

    const listed = await api("GET", "/api/bots");
    const listedBot = listed.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(listedBot?.composer).toEqual({ queueing: false, steer: false, stop: true });
    expect(JSON.stringify(listedBot)).not.toMatch(/canonicalTitle|profile|session-root|runtime-gen/i);

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello Hermes" });
    expect(sent).toEqual({ status: 202, body: { ok: true, disposition: "started" } });
    await waitFor(async () => {
      const current = await api("GET", "/api/bots");
      const found = current.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
      return found?.busy === false && found.messages.some((message: { role: string; text?: string }) =>
        message.role === "bot" && message.text === "fixture Hermes reply");
    }, "the Hermes assistant response");

    const settled = await api("GET", "/api/bots");
    const settledBot = settled.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(settledBot.messages.filter((message: { role: string; text?: string }) => message.role === "bot" && message.text === "fixture Hermes reply")).toHaveLength(1);
    expect(JSON.stringify(settledBot)).not.toContain("root-session");
    expect(JSON.stringify(settledBot)).not.toContain("resolved-session");
    expect(JSON.stringify(settledBot)).not.toContain("runtime-only-session");

    const second = await api("POST", `/api/bots/${bot.id}/messages`, { text: "stay running" });
    expect(second.status).toBe(202);
    await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy === true, "the second Hermes turn");
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy === false, "the interrupted Hermes turn");

    // Binding identity remains authoritative even when the opt-in adapter is
    // disabled. The request settles as a typed setup failure and never reaches
    // the generic Hermes ACP instance selected on the bot.
    const beforeDisabled = await api("GET", "/api/bots");
    const beforeDisabledBot = beforeDisabled.body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    const disabledConfig = await api("PATCH", "/api/config", { vbot: { hermes: { enabled: false } } });
    expect(disabledConfig.status).toBe(200);
    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [bot.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "must not use ACP fallback" })).status).toBe(202);
    await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy === false, "the disabled Hermes binding failure");
    const disabledState = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    expect(disabledState.activity).toBe("dead");
    const beforeDisabledReplies = beforeDisabledBot?.messages.filter((message: { role: string; kind?: string }) => message.role === "bot" && message.kind === "text") ?? [];
    const disabledReplies = disabledState.messages.filter((message: { role: string; kind?: string }) => message.role === "bot" && message.kind === "text");
    expect(disabledReplies).toEqual(beforeDisabledReplies);
    const disabledInterrupt = await api("POST", `/api/bots/${bot.id}/interrupt`);
    expect(disabledInterrupt.status).toBe(409);
    expect(disabledInterrupt.body).toMatchObject({ code: "state_unavailable", setup: true });

    // A broken sidecar is unavailable state, not an empty binding set. The
    // request is retained and settles as setup/dead without falling through
    // to the generic Hermes ACP provider.
    writeFileSync(join(dataDir, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    const malformed = await api("POST", "/api/bots");
    const malformedBot = malformed.body.bot;
    expect((await api("POST", `/api/bots/${malformedBot.id}/messages`, { text: "must not fallback" })).status).toBe(202);
    await waitFor(async () => (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === malformedBot.id)?.busy === false, "the malformed binding failure");
    const malformedState = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === malformedBot.id);
    expect(malformedState.activity).toBe("dead");
    expect(malformedState.messages.some((message: { role: string; text?: string }) => message.role === "user" && message.text === "must not fallback")).toBe(true);
    expect(malformedState.messages.some((message: { role: string; text?: string }) => message.role === "bot" && message.text === "fixture Hermes reply")).toBe(false);
    const malformedInterrupt = await api("POST", `/api/bots/${malformedBot.id}/interrupt`);
    expect(malformedInterrupt.status).toBe(409);
    expect(malformedInterrupt.body).toMatchObject({ code: "malformed_response", setup: true });

    const requests = existsSync(hermesLog)
      ? readFileSync(hermesLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string })
      : [];
    expect(requests.filter((request) => request.method === "prompt.submit")).toHaveLength(2);
    expect(requests.some((request) => request.method === "session.interrupt")).toBe(true);
  }, 30_000);

  it("rejects Hermes-bound membership and room send without generic ACP fallback", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bound = created.body.bot;
    const unboundCreated = await api("POST", "/api/bots");
    expect(unboundCreated.status).toBe(201);
    const unbound = unboundCreated.body.bot;
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      vbot: { hermes: { enabled: true } },
      instances: { hermes: { driver: "hermesAgent", config: { cli: fakeHermes } } },
    }));
    const enabled = await api("PATCH", "/api/config", { vbot: { hermes: { enabled: true } } });
    expect(enabled.status).toBe(200);
    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [bound.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });

    const rejectedCreate = await api("POST", "/api/groups", { name: "Hermes room", memberIds: [bound.id] });
    expect(rejectedCreate.status).toBe(409);
    expect(rejectedCreate.body).toMatchObject({
      error: "Hermes does not support groups",
      code: "groups_unavailable",
      setup: true,
    });

    const room = await api("POST", "/api/groups", { name: "Generic room", memberIds: [unbound.id] });
    expect(room.status).toBe(201);
    expect((await api("PATCH", `/api/groups/${room.body.group.id}/setup`, { action: "skip" })).status).toBe(200);
    const rejectedPatch = await api("PATCH", `/api/groups/${room.body.group.id}`, { memberIds: [unbound.id, bound.id] });
    expect(rejectedPatch.status).toBe(409);
    expect(rejectedPatch.body).toMatchObject({ code: "groups_unavailable", setup: true });

    const before = existsSync(hermesLog) ? readFileSync(hermesLog, "utf8") : "";
    const allowedUnboundSend = await api("POST", `/api/groups/${room.body.group.id}/messages`, { text: "hello unbound room" });
    expect(allowedUnboundSend.status).toBe(202);
    await waitFor(async () => {
      const current = await api("GET", "/api/bots");
      const found = current.body.groups.find((candidate: { id: string }) => candidate.id === room.body.group.id);
      return found?.messages?.some((message: { role: string; text?: string }) => message.role === "user" && message.text === "hello unbound room");
    }, "the unbound room user message");
    const afterUnbound = existsSync(hermesLog) ? readFileSync(hermesLog, "utf8") : "";
    expect(afterUnbound).toBe(before);

    const disabled = await api("PATCH", "/api/config", { vbot: { hermes: { enabled: false } } });
    expect(disabled.status).toBe(200);
    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [bound.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });
    const disabledCreate = await api("POST", "/api/groups", { name: "Disabled bound room", memberIds: [bound.id] });
    expect(disabledCreate.status).toBe(409);
    expect(disabledCreate.body).toMatchObject({ code: "groups_unavailable", setup: true });

    writeFileSync(join(dataDir, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    const malformedCreate = await api("POST", "/api/groups", { name: "Unknown binding room", memberIds: [unbound.id] });
    expect(malformedCreate.status).toBe(409);
    expect(malformedCreate.body).toMatchObject({
      error: "Hermes returned an invalid response",
      code: "malformed_response",
      setup: true,
    });
    const malformedSend = await api("POST", `/api/groups/${room.body.group.id}/messages`, { text: "must not fallback" });
    expect(malformedSend.status).toBe(409);
    expect(malformedSend.body).toMatchObject({ code: "malformed_response", setup: true });
    const malformedInterrupt = await api("POST", `/api/groups/${room.body.group.id}/interrupt`);
    expect(malformedInterrupt.status).toBe(409);
    expect(malformedInterrupt.body).toMatchObject({ code: "malformed_response", setup: true });

    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({ version: 1, bindings: {} }), { mode: 0o600 });
    const restored = await api("PATCH", "/api/config", { vbot: { hermes: { enabled: true } } });
    expect(restored.status).toBe(200);
    const allowed = await api("POST", "/api/groups", { name: "Unbound room", memberIds: [unbound.id] });
    expect(allowed.status).toBe(201);
    expect((await api("PATCH", `/api/groups/${allowed.body.group.id}/setup`, { action: "skip" })).status).toBe(200);
    expect((await api("POST", `/api/groups/${allowed.body.group.id}/messages`, { text: "hello unbound" })).status).toBe(202);
  }, 30_000);

  it("aborts team import rooms on unreadable bindings without partial rooms", async () => {
    const before = await api("GET", "/api/bots");
    const botsBefore = before.body.bots.length;
    const groupsBefore = before.body.groups.length;
    const exported = await api("POST", "/api/teams/export", { name: "Import Team" });
    expect(exported.status).toBe(200);
    writeFileSync(join(dataDir, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    const rejected = await api("POST", "/api/teams/import?mode=project", exported.body);
    expect(rejected.status).toBe(409);
    expect(rejected.body).toMatchObject({ code: "malformed_response", setup: true });
    const afterProject = await api("GET", "/api/bots");
    expect(afterProject.body.bots).toHaveLength(botsBefore);
    expect(afterProject.body.groups).toHaveLength(groupsBefore);

    const packageBody = {
      format: "openmaus.package",
      version: 1,
      package: {
        id: "hermes-gate-package",
        release: "1.0.0",
        name: "Gate Package",
        tagline: "Package import gate test",
        summary: "Checks package room import gates.",
        category: "Test",
        author: { name: "Fixture" },
        license: "MIT",
        outcomes: ["Import cleanly."],
        setupMinutes: 1,
        requirements: { apps: [], capabilities: [] },
        agents: [{
          key: "lead",
          name: "Ada",
          title: "Lead",
          description: "Only member.",
          appearance: { color: "purple" },
        }],
        chiefOfStaff: "lead",
        rooms: [{
          key: "desk",
          name: "Solo Room",
          members: ["lead"],
          bulletin: "Test room.",
          defaultResponder: { kind: "agent", agent: "lead" },
        }],
      },
    };
    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({ version: 1, bindings: {} }), { mode: 0o600 });
    const imported = await api("POST", "/api/teams/import", packageBody);
    expect(imported.status).toBe(201);
    expect(imported.body.groups).toHaveLength(1);
    const botsAfterImport = (await api("GET", "/api/bots")).body.bots.length;

    writeFileSync(join(dataDir, "hermes-bindings.json"), "{not-json", { mode: 0o600 });
    const rejectedPackage = await api("POST", "/api/teams/import", packageBody);
    expect(rejectedPackage.status).toBe(409);
    expect(rejectedPackage.body).toMatchObject({ code: "malformed_response", setup: true });
    const afterPackage = await api("GET", "/api/bots");
    expect(afterPackage.body.bots).toHaveLength(botsAfterImport);
    expect(afterPackage.body.groups.filter((group: { name: string }) => group.name === "Solo Room")).toHaveLength(1);
  }, 30_000);

  it("interrupts a mixed room through the busy unbound member", async () => {
    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({ version: 1, bindings: {} }), { mode: 0o600 });
    const boundCreated = await api("POST", "/api/bots");
    const unboundCreated = await api("POST", "/api/bots");
    const bound = boundCreated.body.bot;
    const unbound = unboundCreated.body.bot;
    await api("PATCH", `/api/bots/${unbound.id}`, { name: "Runner" });
    const room = await api("POST", "/api/groups", { name: "Mixed", memberIds: [bound.id, unbound.id] });
    expect(room.status).toBe(201);
    expect((await api("PATCH", `/api/groups/${room.body.group.id}/setup`, { action: "skip" })).status).toBe(200);
    expect((await api("PATCH", `/api/groups/${room.body.group.id}`, {
      defaultResponder: { kind: "member", botId: unbound.id },
    })).status).toBe(200);
    writeFileSync(join(dataDir, "hermes-bindings.json"), JSON.stringify({
      version: 1,
      bindings: {
        [bound.id]: {
          adapter: "hermesBot",
          profile: "default",
          canonicalTitle: "Bot Chat",
          bindingVersion: 1,
        },
      },
    }), { mode: 0o600 });

    const started = await api("POST", `/api/groups/${room.body.group.id}/messages`, { text: "keep working" });
    expect(started.status).toBe(202);
    await waitFor(async () => {
      const current = await api("GET", "/api/bots");
      const found = current.body.groups.find((candidate: { id: string }) => candidate.id === room.body.group.id);
      return Boolean(found?.busyBotId);
    }, "the mixed room turn");

    const stopped = await api("POST", `/api/groups/${room.body.group.id}/interrupt`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ ok: true });
  }, 30_000);
});
