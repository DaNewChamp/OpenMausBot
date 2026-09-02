import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodeHermesBridgeResult } from "../shared/bridge-hermes-contract.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

type Json = { status: number; body: unknown };

const DISCOVERY_CAPABILITIES = {
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
  adoptMint: true,
  approvals: true,
  exclusiveSubmit: false,
};

const DISCOVERY_PROFILES = [{
  profile: "default",
  handle: "hermes",
  displayName: "Hermes",
  description: "Remote assistant",
  canonicalChat: "absent" as const,
  availability: "available" as const,
}];

async function waitHealth(base: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr()}`);
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function api(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Json> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: response.status, body: parsed };
}

function hermesStdout(kind: string, payload: Record<string, unknown>): string {
  return encodeHermesBridgeResult({ kind, body: payload } as never);
}

function spawnHarness() {
  const port = 29_000 + Math.floor(Math.random() * 5_000);
  const home = mkdtempSync(join(tmpdir(), "vbot-hermes-bridge-http-"));
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    vbot: { hermes: { enabled: false } },
    instances: { hermes: { driver: "hermesAgent", config: {} } },
  }), { mode: 0o600 });
  let stderr = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_DATA_DIR: dataDir,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return { port, base: `http://127.0.0.1:${port}`, home, dataDir, child, stderr: () => stderr };
}

describe("Hermes bridge setup over HTTP", () => {
  let harness: ReturnType<typeof spawnHarness>;
  let bridgeId = "";
  let bridgeToken = "";
  let connectedBotId = "";
  let stopWorker: (() => void) | undefined;
  const hermesSendJobs: string[] = [];

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    api(harness.base, method, path, body, headers);

  async function pairBridge(name: string) {
    const pairing = await call("POST", "/api/bridge/pairing");
    expect(pairing.status).toBe(200);
    const registered = await call("POST", "/api/bridge/register", {
      name,
      code: (pairing.body as { code: string }).code,
      capabilities: ["hermes"],
    });
    expect(registered.status).toBe(200);
    const body = registered.body as { bridgeId: string; bridgeToken: string };
    await call("POST", "/api/bridge/heartbeat", { bridgeId: body.bridgeId, capabilities: ["hermes"] }, {
      authorization: `Bearer ${body.bridgeToken}`,
    });
    return body;
  }

  function startBridgeWorker(id: string, token: string) {
    let running = true;
    const loop = async () => {
      while (running) {
        const beat = await call("POST", "/api/bridge/heartbeat", { bridgeId: id }, {
          authorization: `Bearer ${token}`,
        });
        const jobs = ((beat.body as { jobs?: Array<{ id: string; kind: string; generation?: number; payload?: { turnId?: string; threadId?: string } }> }).jobs) ?? [];
        for (const job of jobs) {
          let stdout = "";
          if (job.kind === "hermes-discover") {
            stdout = hermesStdout("hermes-discover", {
              state: "available",
              capabilities: DISCOVERY_CAPABILITIES,
              profiles: DISCOVERY_PROFILES,
            });
          } else if (job.kind === "hermes-ensure-canonical") {
            stdout = hermesStdout("hermes-ensure-canonical", { state: "present", adopted: true });
          } else if (job.kind === "hermes-send") {
            hermesSendJobs.push(job.id);
            stdout = hermesStdout("hermes-send", {
              ok: true,
              turnId: job.payload?.turnId ?? "turn-1",
              events: [{
                eventId: `evt-${job.id}`,
                provider: "hermesBot",
                threadId: job.payload?.threadId ?? "thread-1",
                turnId: job.payload?.turnId ?? "turn-1",
                createdAt: "2026-09-01T00:00:00.000Z",
                type: "turn.completed",
                ok: true,
              }],
            });
          }
          await call("POST", "/api/bridge/result", {
            jobId: job.id,
            bridgeId: id,
            exitCode: 0,
            stdout,
            stderr: "",
            truncated: false,
            generation: job.generation,
          }, { authorization: `Bearer ${token}` });
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    void loop();
    return () => { running = false; };
  }

  async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    harness = spawnHarness();
    await waitHealth(harness.base, harness.child, harness.stderr);
    const paired = await pairBridge("Mac mini");
    bridgeId = paired.bridgeId;
    bridgeToken = paired.bridgeToken;
    stopWorker = startBridgeWorker(bridgeId, bridgeToken);
  }, 40_000);

  afterAll(async () => {
    stopWorker?.();
    await waitForExit(harness.child, { signal: "SIGTERM" });
    await removeTempDir(harness.home);
  });

  it("GET ready then POST bridge placement connects without auto-enabling local Hermes", async () => {
    await waitFor(async () => {
      const status = await call("GET", "/api/hermes/setup/status");
      return status.status === 200
        && (status.body as { state?: string }).state === "ready"
        && Array.isArray((status.body as { profiles?: unknown[] }).profiles)
        && ((status.body as { profiles: unknown[] }).profiles.length > 0);
    }, "ready bridge setup status");

    const ready = await call("GET", "/api/hermes/setup/status");
    expect(ready.body).toMatchObject({
      state: "ready",
      profiles: [expect.objectContaining({
        profile: "default",
        placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
      })],
    });
    expect(JSON.stringify(ready.body)).not.toMatch(/bridgeId|HERMES_HOME|jsonrpc|Bearer |sk-/i);

    const connected = await call("POST", "/api/hermes/setup", {
      placement: { kind: "bridge", bridge: "mac mini", profile: "default" },
    });
    expect(connected.status).toBe(201);
    expect(connected.body).toMatchObject({
      created: true,
      profile: {
        profile: "default",
        botId: expect.any(String),
        placement: { kind: "bridge", bridge: "Mac mini", profile: "default" },
      },
      status: { state: "connected" },
    });
    expect(JSON.stringify(connected.body)).not.toMatch(/bridgeId|HERMES_HOME|jsonrpc|Bearer |sk-/i);

    const config = JSON.parse(readFileSync(join(harness.dataDir, "config.json"), "utf8")) as {
      vbot?: { hermes?: { enabled?: boolean } };
    };
    expect(config.vbot?.hermes?.enabled).not.toBe(true);

    const botId = (connected.body as { botId: string }).botId;
    connectedBotId = botId;
    const bots = await call("GET", "/api/bots");
    const bot = (bots.body as { bots: Array<{ id: string; modelSelection: { instanceId: string }; title?: string }> }).bots
      .find((candidate) => candidate.id === botId);
    expect(bot).toMatchObject({
      title: "Hermes Bot Chat",
      modelSelection: { instanceId: "hermes" },
    });

    const sent = await call("POST", `/api/bots/${botId}/messages`, { text: "hello bridge" });
    expect(sent.status).toBe(202);
    await waitFor(async () => hermesSendJobs.length > 0, "bridge hermes-send job");
    await waitFor(async () => {
      const current = await call("GET", "/api/bots");
      const found = (current.body as { bots: Array<{ id: string; busy?: boolean }> }).bots
        .find((candidate) => candidate.id === botId);
      return found?.busy === false;
    }, "bridge turn completion");
    expect(existsSync(join(harness.home, "hermes-home", "requests.ndjson"))).toBe(false);
  }, 45_000);

  it("fails closed when the bridge is offline or revoked", async () => {
    expect(connectedBotId).toBeTruthy();
    const revoked = await call("DELETE", `/api/bridges/${bridgeId}`);
    expect(revoked.status).toBe(200);

    await waitFor(async () => {
      const status = await call("GET", "/api/hermes/setup/status");
      return status.status === 200 && (status.body as { state?: string }).state === "disabled";
    }, "disabled setup after revoke");
    expect((await call("GET", "/api/hermes/setup/status")).body).toMatchObject({
      state: "disabled",
      profiles: [],
    });

    const rejected = await call("POST", "/api/hermes/setup", {
      placement: { kind: "bridge", bridge: "mac mini", profile: "default" },
    });
    expect(rejected.status).toBe(409);
    expect(JSON.stringify(rejected.body)).not.toMatch(/bridgeId/i);

    const sendCountBefore = hermesSendJobs.length;
    expect((await call("POST", `/api/bots/${connectedBotId}/messages`, { text: "must fail closed" })).status).toBe(202);
    await waitFor(async () => {
      const current = await call("GET", "/api/bots");
      const found = (current.body as { bots: Array<{ id: string; busy?: boolean; activity?: string }> }).bots
        .find((candidate) => candidate.id === connectedBotId);
      return found?.busy === false;
    }, "revoked bridge send failure");
    expect(hermesSendJobs.length).toBe(sendCountBefore);
    const deadBot = (await call("GET", "/api/bots")).body as { bots: Array<{ id: string; activity?: string }> };
    expect(deadBot.bots.find((candidate) => candidate.id === connectedBotId)?.activity).toBe("dead");
  }, 30_000);
});
