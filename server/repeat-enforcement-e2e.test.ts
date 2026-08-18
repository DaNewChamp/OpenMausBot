// Loop enforcement, end to end: the fake claude runs the same call over and
// over inside one turn. At 5 the harness nudges the model (steered into the
// live session — the fake folds it into its reply) and chips; at the
// ceiling it stops the turn.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("repeat-call enforcement e2e", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-repeat-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          loop: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "loop" }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          hard: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "loop-hard" }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("nudges the model into the running turn at 5 identical calls, and says so", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "loop", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "go" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the loop turn to settle");
    const bot = await getBot(created.id);
    const chips = bot.messages.filter((m: any) => m.kind === "activity").map((m: any) => m.tool?.name ?? "");
    // the 5× chip says the bot was nudged (Claude can take a message mid-turn)
    expect(chips.some((c: string) => /Same call repeated 5×.*Bash: git status.*nudged/.test(c))).toBe(true);
    // and the nudge reached the model inside the SAME turn: the reply folds it in
    const reply = bot.messages.find((m: any) => m.role === "bot" && m.kind === "text" && m.text?.startsWith("loop reply"));
    expect(reply?.text).toMatch(/steered: OpenMausBot: you have now run the same call 5 times/);
    // one turn, not stopped: no stop chip
    expect(chips.some((c: string) => /stopped — the same call/.test(c))).toBe(false);
  }, 40_000);

  it("stops the turn at the ceiling when the loop never breaks", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "hard", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "go" })).status).toBe(202);
    await waitFor(async () => {
      const b = await getBot(created.id);
      return !b.busy && b.messages.some((m: any) => m.kind === "activity" && /^error: stopped — the same call repeated 20×/.test(m.tool?.name ?? ""));
    }, "the turn to be stopped at 20 repeats", 40_000);
    const bot = await getBot(created.id);
    const chips = bot.messages.filter((m: any) => m.kind === "activity").map((m: any) => m.tool?.name ?? "");
    // it was nudged twice on the way (5, 10) before the ceiling
    expect(chips.filter((c: string) => /nudged/.test(c)).length).toBe(2);
  }, 60_000);
});
