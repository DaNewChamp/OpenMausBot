// HTTP integration for the internal bridge shell/ssh approval gate.
// Spawns the real harness so the hold, join, owner bind, disconnect, and
// expiry paths are the same ones agents-proxy hits.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const posixOnly = describe.skipIf(process.platform === "win32");
const TOKEN = "a".repeat(48);

type Json = { status: number; body: any };

async function waitHealth(base: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr()}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr()}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function json(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

function spawnHarness(opts: { approvalTimeoutMs?: number; sshTargets?: boolean }) {
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const home = mkdtempSync(join(tmpdir(), "omb-bridge-http-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
      ...(opts.sshTargets
        ? {
            bridgeSshTargets: {
              nas: { bridge: "mini", alias: "nas" },
              other: { bridge: "other-mini", alias: "other" },
            },
          }
        : {}),
    }),
  );
  let stderr = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_COMMS_TOKEN: TOKEN,
      ...(opts.approvalTimeoutMs != null
        ? { OMB_BRIDGE_APPROVAL_TIMEOUT_MS: String(opts.approvalTimeoutMs) }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => {
    stderr += c;
  });
  return { port, base: `http://127.0.0.1:${port}`, home, child, stderr: () => stderr };
}

posixOnly("internal bridge approval over HTTP", () => {
  let harness: ReturnType<typeof spawnHarness>;
  let bot: { id: string; threadId: string };
  let other: { id: string; threadId: string };
  let bridgeId = "";
  let bridgeToken = "";
  let jobsCompleted = 0;

  const api = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    json(harness.base, method, path, body, headers);
  const internal = (path: string, body: unknown, extra?: RequestInit) =>
    fetch(`${harness.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      ...extra,
    });

  async function pairBridge(name: string, capabilities: string[]) {
    const pairing = await api("POST", "/api/bridge/pairing");
    expect(pairing.status).toBe(200);
    const registered = await api("POST", "/api/bridge/register", {
      name,
      code: pairing.body.code,
      capabilities,
    });
    expect(registered.status).toBe(200);
    await api("POST", "/api/bridge/heartbeat", { bridgeId: registered.body.bridgeId, capabilities }, {
      authorization: `Bearer ${registered.body.bridgeToken}`,
    });
    return { bridgeId: registered.body.bridgeId as string, bridgeToken: registered.body.bridgeToken as string };
  }

  async function drainJobs(token: string, id: string) {
    const beat = await api("POST", "/api/bridge/heartbeat", { bridgeId: id }, { authorization: `Bearer ${token}` });
    const jobs = (beat.body.jobs ?? []) as Array<{ id: string; generation?: number; command?: string }>;
    for (const job of jobs) {
      jobsCompleted += 1;
      await api(
        "POST",
        "/api/bridge/result",
        {
          jobId: job.id,
          bridgeId: id,
          exitCode: 0,
          stdout: `ran:${job.id}\n`,
          stderr: "",
          truncated: false,
          generation: job.generation,
        },
        { authorization: `Bearer ${token}` },
      );
    }
    return jobs;
  }

  async function waitForCard(botId: string, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const { body } = await api("GET", "/api/bots");
      const found = (body.bots ?? []).find((b: { id: string }) => b.id === botId);
      const card = found?.messages?.find(
        (m: { kind: string; card?: { requestId?: string; answered?: string; dismissed?: boolean } }) =>
          m.kind === "options" && m.card?.requestId && !m.card.answered && m.card.dismissed !== true,
      );
      if (card) return card;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  beforeAll(async () => {
    harness = spawnHarness({ sshTargets: true });
    await waitHealth(harness.base, harness.child, harness.stderr);
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    bot = created.body.bot;
    const createdOther = await api("POST", "/api/bots");
    expect(createdOther.status).toBe(201);
    other = createdOther.body.bot;
    const paired = await pairBridge("mini", ["shell", "ssh-forward"]);
    bridgeId = paired.bridgeId;
    bridgeToken = paired.bridgeToken;
  }, 30_000);

  afterAll(async () => {
    await waitForExit(harness.child, { signal: "SIGTERM" });
    await removeTempDir(harness.home);
  });

  it("returns 400 and no card when no eligible bridge exists", async () => {
    const res = await internal("/api/internal/bridge/shell", {
      command: "echo nobody",
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
      bridge: "missing-bridge",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(String(body.error)).toMatch(/no online bridge/i);
    expect(await waitForCard(bot.id, 400)).toBeNull();
  });

  it("holds a missing grant until the owning bot approves once, and runs exactly once", async () => {
    jobsCompleted = 0;
    const held = internal("/api/internal/bridge/shell", {
      command: "echo hold",
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
      bridgeId,
    });
    const card = await waitForCard(bot.id);
    expect(card, "missing grant must hold a real card").not.toBeNull();
    expect(card.card.allowKey).toBe("bridge:run_on_bridge:echo");
    expect(card.card.title).toContain(bridgeId);

    const wrongBot = await api("POST", `/api/bots/${other.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    expect(wrongBot.status).toBe(403);
    expect(wrongBot.body.outcome).not.toBe("allowed-once");

    const wrongThread = await api("POST", `/api/threads/${other.threadId}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    expect(wrongThread.status).toBe(403);
    expect(wrongThread.body.outcome).not.toBe("allowed-once");

    const stillHeld = await Promise.race([
      held.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("waiting"), 200)),
    ]);
    expect(stillHeld).toBe("waiting");

    const allow = api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    const drain = (async () => {
      for (let i = 0; i < 40; i += 1) {
        const jobs = await drainJobs(bridgeToken, bridgeId);
        if (jobs.length) return jobs;
        await new Promise((r) => setTimeout(r, 50));
      }
      return [];
    })();
    const [allowed, jobs, result] = await Promise.all([allow, drain, held]);
    expect(allowed.status).toBe(200);
    expect(allowed.body.outcome).toBe("allowed-once");
    expect(result.status).toBe(200);
    const payload = (await result.json()) as { exitCode: number };
    expect(payload.exitCode).toBe(0);
    expect(jobs).toHaveLength(1);
    expect(jobsCompleted).toBe(1);

    const replay = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    expect(replay.body.outcome).not.toBe("allowed-once");
  });

  it("joins concurrent identical requests into one execution/result", async () => {
    jobsCompleted = 0;
    const body = {
      command: "echo join",
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
      bridgeId,
      cwd: "/tmp",
      timeoutMs: 8_000,
    };
    const first = internal("/api/internal/bridge/shell", body);
    const second = internal("/api/internal/bridge/shell", body);
    const card = await waitForCard(bot.id);
    expect(card).not.toBeNull();
    const allowP = api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    const jobsP = (async () => {
      for (let i = 0; i < 40; i += 1) {
        const jobs = await drainJobs(bridgeToken, bridgeId);
        if (jobs.length) return jobs;
        await new Promise((r) => setTimeout(r, 50));
      }
      return [];
    })();
    const [a, b, allowed, jobs] = await Promise.all([first, second, allowP, jobsP]);
    expect(allowed.status).toBe(200);
    expect(allowed.body.outcome).toBe("allowed-once");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const pa = (await a.json()) as { stdout?: string };
    const pb = (await b.json()) as { stdout?: string };
    expect(pa.stdout).toBe(pb.stdout);
    expect(jobs).toHaveLength(1);
    expect(jobsCompleted).toBe(1);
  });

  it("does not join an altered command, cwd, timeout, or jump bridge", async () => {
    const otherPaired = await pairBridge("other-mini", ["ssh-forward"]);
    const base = {
      command: "echo distinct",
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
      bridgeId,
    };
    const first = internal("/api/internal/bridge/shell", base);
    await waitForCard(bot.id);
    const second = internal("/api/internal/bridge/shell", { ...base, command: "echo other" });
    const third = internal("/api/internal/bridge/shell", { ...base, cwd: "/var" });
    const fourth = internal("/api/internal/bridge/shell", { ...base, timeoutMs: 3_000 });
    const sshA = internal("/api/internal/bridge/ssh", {
      command: "echo distinct",
      target: "nas",
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
    });
    const sshB = internal("/api/internal/bridge/ssh", {
      command: "echo distinct",
      target: "nas",
      bridge: "other-mini",
      fromBotId: bot.id,
      fromThreadId: bot.threadId,
    });
    await new Promise((r) => setTimeout(r, 200));
    const { body } = await api("GET", "/api/bots");
    const found = (body.bots ?? []).find((b: { id: string }) => b.id === bot.id);
    const live = (found?.messages ?? []).filter(
      (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
        m.kind === "options" && m.card?.requestId && !m.card.answered,
    );
    expect(live.length).toBeGreaterThanOrEqual(6);
    for (const card of live) {
      await api("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "deny" });
    }
    expect((await first).status).toBe(403);
    expect((await second).status).toBe(403);
    expect((await third).status).toBe(403);
    expect((await fourth).status).toBe(403);
    expect((await sshA).status).toBe(403);
    expect((await sshB).status).toBe(403);
    expect(otherPaired.bridgeId).not.toBe(bridgeId);
  });

  it("aborts the pending card when the requester disconnects so a later Allow cannot run it", async () => {
    jobsCompleted = 0;
    const ac = new AbortController();
    const held = internal(
      "/api/internal/bridge/shell",
      { command: "echo abandoned", fromBotId: bot.id, fromThreadId: bot.threadId, bridgeId },
      { signal: ac.signal },
    );
    const card = await waitForCard(bot.id);
    expect(card).not.toBeNull();
    ac.abort();
    await held.catch(() => undefined);
    const deadline = Date.now() + 2_000;
    let settled = false;
    while (Date.now() < deadline) {
      const { body } = await api("GET", "/api/bots");
      const found = (body.bots ?? []).find((b: { id: string }) => b.id === bot.id);
      const live = found?.messages?.find((m: { id: string }) => m.id === card.id);
      if (live?.card?.answered) {
        settled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(settled).toBe(true);
    const allow = await api("POST", `/api/bots/${bot.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    expect(allow.body.outcome).not.toBe("allowed-once");
    await drainJobs(bridgeToken, bridgeId);
    expect(jobsCompleted).toBe(0);
  });
});

posixOnly("internal bridge approval expiry over HTTP", () => {
  let harness: ReturnType<typeof spawnHarness>;
  let bot: { id: string; threadId: string };
  let bridgeId = "";

  const api = (method: string, path: string, body?: unknown) => json(harness.base, method, path, body);

  beforeAll(async () => {
    harness = spawnHarness({ approvalTimeoutMs: 200 });
    await waitHealth(harness.base, harness.child, harness.stderr);
    const created = await api("POST", "/api/bots");
    bot = created.body.bot;
    const pairing = await api("POST", "/api/bridge/pairing");
    const registered = await api("POST", "/api/bridge/register", {
      name: "mini",
      code: pairing.body.code,
      capabilities: ["shell"],
    });
    bridgeId = registered.body.bridgeId;
    await fetch(`${harness.base}/api/bridge/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${registered.body.bridgeToken}`,
      },
      body: JSON.stringify({ bridgeId, capabilities: ["shell"] }),
    });
  }, 30_000);

  afterAll(async () => {
    await waitForExit(harness.child, { signal: "SIGTERM" });
    await removeTempDir(harness.home);
  });

  it("reports expired rather than allowed-once when Allow arrives after the card times out", async () => {
    const held = fetch(`${harness.base}/api/internal/bridge/shell`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ command: "echo late", fromBotId: bot.id, fromThreadId: bot.threadId, bridgeId }),
    });
    let requestId = "";
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !requestId) {
      const { body } = await api("GET", "/api/bots");
      const found = (body.bots ?? []).find((b: { id: string }) => b.id === bot.id);
      const card = found?.messages?.find(
        (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
          m.kind === "options" && m.card?.requestId,
      );
      if (card?.card?.requestId) requestId = card.card.requestId;
      else await new Promise((r) => setTimeout(r, 40));
    }
    expect(requestId).toBeTruthy();
    const denied = await held;
    expect(denied.status).toBe(403);
    const allow = await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "allow" });
    expect(allow.status).toBe(200);
    expect(allow.body.outcome).toBe("expired");
    expect(allow.body.outcome).not.toBe("allowed-once");
  });
});
