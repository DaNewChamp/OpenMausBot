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
if (process.argv[2] !== "--tui") { process.exit(2); }
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
    if (request.method === "profiles.list") {
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
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
  writeFileSync(fakeHermes, FAKE_HERMES_SOURCE, { mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    vbot: { hermes: { enabled: true } },
    instances: { hermes: { driver: "hermesAgent", config: { cli: fakeHermes } } },
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
  it("dispatches a bound bot once, projects safe capabilities, and interrupts without a fallback", async () => {
    const instances = await api("GET", "/api/instances");
    expect(instances.status).toBe(200);
    const hermes = instances.body.instances.find((entry: { instanceId?: string }) => entry.instanceId === "hermes");
    expect(hermes).toMatchObject({
      instanceId: "hermes",
      capabilities: {
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

    const requests = existsSync(hermesLog)
      ? readFileSync(hermesLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method?: string })
      : [];
    expect(requests.filter((request) => request.method === "prompt.submit")).toHaveLength(2);
    expect(requests.some((request) => request.method === "session.interrupt")).toBe(true);
  }, 30_000);
});
