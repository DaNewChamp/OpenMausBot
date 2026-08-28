import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { recordEvents } from "../testing/events.ts";
import {
  ACTIVE_SESSION_ID,
  DRIVER_KIND,
  RECONSTRUCTED_APP_NAME,
  RECONSTRUCTED_BUNDLE_ID,
  STABLE_GATEWAY_METHODS,
  bundleIdFromInfoPlist,
  createGrokReconstructedDriver,
  detectReconstructedRuntime,
  extractAssistantText,
  fetchVbotActivity,
  fetchVbotBots,
  fetchVbotGroups,
  fetchVbotProviders,
  fetchVbotRouter,
  isAllowedLoopbackOrigin,
  isLoopbackHost,
  isReconstructedProcessCommand,
  leaksSensitive,
  parseGatewayDiscovery,
  publicDisabledReason,
  reconstructedDiscoveryPath,
  reconstructedDiscoveryPaths,
  reconstructedIsolatedDiscoveryPath,
  sanitizeAgentSessions,
  sessionsToCatalog,
  setVbotRouter,
  stopVbotBot,
  submitVbotTurn,
  type ReconstructedRuntimeHost,
} from "./grok-reconstructed.ts";

const TOKEN = "test-reconstructed-token";

function plist(bundleId: string) {
  return `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`;
}

function hostFrom(overrides: Partial<ReconstructedRuntimeHost> & { homeDir: string }): ReconstructedRuntimeHost {
  return {
    platform: "darwin",
    applicationsDirs: [],
    readText: () => null,
    existsDir: () => false,
    isProcessAlive: () => false,
    readProcessCommand: () => null,
    fetch: globalThis.fetch.bind(globalThis),
    delay: async () => {},
    now: Date.now,
    ...overrides,
  };
}

interface FakeGateway {
  port: number;
  pid: number;
  origin: string;
  close: () => Promise<void>;
  agents: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown>>;
  running: boolean;
  inferenceProvider: string;
  cursorModelId: string;
  seen: {
    origins: string[];
    paths: string[];
    unauthorized: number;
    sendPrompts: unknown[];
    slimAvatars: number;
    routerPuts: unknown[];
    turns: unknown[];
    steers: unknown[];
    stops: string[];
  };
}

async function startFakeGateway(options?: {
  token?: string | null;
  pid?: number;
  healthPid?: number;
  healthOk?: boolean;
  listAgents?: boolean;
  sendPrompt?: boolean;
  assistantReply?: string | false;
  vbot?: boolean;
  stop?: boolean;
}): Promise<FakeGateway> {
  const token = options?.token === undefined ? TOKEN : options.token;
  const pid = options?.pid ?? 4242;
  const healthPid = options?.healthPid ?? pid;
  const healthOk = options?.healthOk ?? true;
  const listAgents = options?.listAgents ?? true;
  const sendPrompt = options?.sendPrompt ?? true;
  const assistantReply = options?.assistantReply === undefined ? "hello from reconstructed" : options.assistantReply;
  const vbot = options?.vbot ?? false;
  const stopBound = options?.stop ?? true;
  const seen = {
    origins: [] as string[],
    paths: [] as string[],
    unauthorized: 0,
    sendPrompts: [] as unknown[],
    slimAvatars: 0,
    routerPuts: [] as unknown[],
    turns: [] as unknown[],
    steers: [] as unknown[],
    stops: [] as string[],
  };
  const state: FakeGateway = {
    port: 0,
    pid,
    origin: "",
    close: async () => {},
    agents: [
      {
        id: "bot-alpha",
        name: "Alpha",
        title: "",
        path: "/Users/someone/.grokbot/agents/bot-alpha/store.db",
        avatarDataUrl: "data:image/png;base64,aaaa",
        isActive: true,
        isRunning: false,
      },
    ],
    entries: [],
    running: false,
    inferenceProvider: "cursor",
    cursorModelId: "grok-4.5",
    seen,
  };

  const authorized = (req: IncomingMessage) => {
    if (req.headers.origin) return false;
    if (!token) return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw.length > 0 ? JSON.parse(raw) : {};
  };

  const json = (res: ServerResponse, status: number, value: unknown) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.paths.push(`${req.method} ${url.pathname}`);
    if (typeof req.headers.origin === "string") seen.origins.push(req.headers.origin);
    if (req.headers["x-sand-slim-avatars"] === "1") seen.slimAvatars += 1;
    if (!authorized(req)) {
      seen.unauthorized += 1;
      json(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        if (!healthOk) {
          json(res, 500, { error: "unhealthy" });
          return;
        }
        json(res, 200, { ok: true, pid: healthPid, isBusy: state.running, startedAt: 1 });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/listAgents") {
        if (!listAgents) {
          json(res, 404, { error: "not found" });
          return;
        }
        json(res, 200, state.agents.map((agent) => ({ ...agent, isRunning: state.running })));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/sendPrompt") {
        if (!sendPrompt) {
          json(res, 404, { error: "not found" });
          return;
        }
        const body = await readBody(req);
        seen.sendPrompts.push(body);
        state.running = true;
        state.entries.push({
          id: "user-1",
          kind: "message",
          content: body.prompt,
        });
        setTimeout(() => {
          if (assistantReply !== false) {
            state.entries.push({
              id: "asst-1",
              kind: "send-message",
              message: { type: "text", content: assistantReply },
            });
          }
          state.running = false;
        }, 20);
        json(res, 200, { accepted: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/getAgentTranscriptTail") {
        json(res, 200, { entries: state.entries });
        return;
      }
      if (url.pathname === "/vbot/v1" || url.pathname.startsWith("/vbot/v1/")) {
        if (!vbot) {
          json(res, 404, { schemaVersion: 1, error: { code: "not_found", message: "not found" } });
          return;
        }
        const vbotError = (status: number, code: string, message: string, action?: string) => {
          json(res, status, {
            schemaVersion: 1,
            error: { code, message, ...(action ? { action } : {}) },
          });
        };
        const catalog = () => ({
          schemaVersion: 1,
          scope: "host",
          perBotSelection: false,
          defaultProvider: "cursor",
          currentProvider: state.inferenceProvider,
          currentModelId: state.inferenceProvider === "cursor" ? state.cursorModelId : "claude-code",
          providers: [
            {
              id: "cursor",
              label: "Cursor",
              current: state.inferenceProvider === "cursor",
              selectable: true,
              modelSelectable: true,
              models: [{ id: state.cursorModelId, current: true, selectable: true }],
            },
            {
              id: "claude-code",
              label: "Claude Code",
              current: state.inferenceProvider === "claude-code",
              selectable: true,
              modelSelectable: false,
              models: [{ id: "claude-code", current: true, selectable: false }],
            },
          ],
        });
        const bot = () => ({
          id: "bot-alpha",
          kind: "bot",
          name: "Alpha",
          title: "",
          description: "",
          memberIds: [],
          isActive: true,
          isRunning: state.running,
          isRunningTurn: state.running,
          isComposingMessage: false,
          isRetrying: false,
          awaitingUserResponse: false,
          lastActivityAt: 0,
          updatedAt: 0,
          activity: { kind: state.running ? "thinking" : "idle" },
        });
        if (req.method === "GET" && url.pathname === "/vbot/v1") {
          json(res, 200, {
            schemaVersion: 1,
            apiVersion: "v1",
            loopbackOnly: true,
            auth: "bearer-discovery-token",
            routerScope: "host",
            defaultProvider: "cursor",
            providers: ["cursor", "claude-code", "codex", "openrouter"],
            actions: {
              listBots: true,
              listGroups: true,
              listProviders: true,
              selectHostRouter: true,
              selectBotRouter: false,
              submitPrompt: true,
              queryActivity: true,
              steer: true,
              stop: stopBound,
            },
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/vbot/v1/bots") {
          json(res, 200, { schemaVersion: 1, bots: [bot()] });
          return;
        }
        if (req.method === "GET" && url.pathname === "/vbot/v1/groups") {
          json(res, 200, {
            schemaVersion: 1,
            groups: [
              {
                id: "group-ops",
                kind: "group",
                name: "Ops",
                title: "",
                description: "",
                memberIds: ["bot-alpha"],
                isActive: false,
                isRunning: false,
                isRunningTurn: false,
                isComposingMessage: false,
                isRetrying: false,
                awaitingUserResponse: false,
                lastActivityAt: 0,
                updatedAt: 0,
                activity: { kind: "idle" },
              },
            ],
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/vbot/v1/providers") {
          json(res, 200, catalog());
          return;
        }
        if (req.method === "GET" && url.pathname === "/vbot/v1/router") {
          const current = catalog();
          json(res, 200, {
            ...current,
            selected: {
              provider: current.currentProvider,
              modelId: current.currentModelId,
              scope: "host",
            },
          });
          return;
        }
        if (req.method === "PUT" && url.pathname === "/vbot/v1/router") {
          const body = await readBody(req);
          seen.routerPuts.push(body);
          if (body.provider === "claude-code" && typeof body.modelId === "string") {
            vbotError(409, "unsupported_action", "claude-code model selection is owned by the local provider", "provider_model_select");
            return;
          }
          if (typeof body.provider === "string") state.inferenceProvider = body.provider;
          if (typeof body.modelId === "string") state.cursorModelId = body.modelId;
          const current = catalog();
          json(res, 200, {
            ...current,
            selected: {
              provider: current.currentProvider,
              modelId: current.currentModelId,
              scope: "host",
            },
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/vbot/v1/bots/bot-alpha/activity") {
          json(res, 200, {
            schemaVersion: 1,
            botId: "bot-alpha",
            bot: bot(),
            host: { isBusy: state.running, busyOnlyAwaitingApproval: false, activeAgentId: "bot-alpha", lastBusyAtMs: 0 },
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/vbot/v1/bots/bot-alpha/turns") {
          const body = await readBody(req);
          seen.turns.push(body);
          json(res, 200, { schemaVersion: 1, accepted: true, botId: "bot-alpha", steered: false });
          return;
        }
        if (req.method === "POST" && url.pathname === "/vbot/v1/bots/bot-alpha/steer") {
          const body = await readBody(req);
          seen.steers.push(body);
          json(res, 200, { schemaVersion: 1, accepted: true, botId: "bot-alpha", steered: true });
          return;
        }
        if (req.method === "POST" && url.pathname === "/vbot/v1/bots/bot-alpha/stop") {
          seen.stops.push("bot-alpha");
          if (!stopBound) {
            vbotError(409, "unsupported_action", "stop is unavailable", "stop");
            return;
          }
          json(res, 200, { schemaVersion: 1, botId: "bot-alpha", stopped: true });
          return;
        }
        vbotError(404, "not_found", `not found: ${req.method} ${url.pathname}`);
        return;
      }
      json(res, 404, { error: `not found: ${req.method} ${url.pathname}` });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("fake gateway did not bind");
  state.port = address.port;
  state.origin = `http://127.0.0.1:${address.port}`;
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  return state;
}

describe("reconstructed gateway discovery", () => {
  it("accepts only loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.9")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("parses a stable discovery record and rejects unusable fields", () => {
    expect(
      parseGatewayDiscovery({
        port: 18765,
        pid: 99,
        startedAt: 1,
        scheme: "http",
        host: "127.0.0.1",
        token: TOKEN,
      }),
    ).toEqual({
      port: 18765,
      pid: 99,
      startedAt: 1,
      scheme: "http",
      host: "127.0.0.1",
      token: TOKEN,
    });
    expect(parseGatewayDiscovery({ port: 80, pid: 1, startedAt: 1, host: 12 })).toBeNull();
    expect(parseGatewayDiscovery({ port: 0, pid: 1, startedAt: 1 })).toBeNull();
    expect(
      parseGatewayDiscovery({ port: 80, pid: 1, startedAt: 1, host: "8.8.8.8", token: TOKEN }),
    ).toMatchObject({ host: "8.8.8.8" });
    expect(isAllowedLoopbackOrigin("http://127.0.0.1:18765")).toBe(true);
    expect(isAllowedLoopbackOrigin("http://localhost:18765")).toBe(false);
    expect(isAllowedLoopbackOrigin("http://8.8.8.8:80")).toBe(false);
    expect(STABLE_GATEWAY_METHODS).toEqual(["listAgents", "sendPrompt", "getAgentTranscriptTail"]);
  });

  it("recognizes the reconstructed process and bundle id", () => {
    expect(isReconstructedProcessCommand(`/Applications/${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main`)).toBe(
      true,
    );
    expect(isReconstructedProcessCommand(`Grok Bot.app/Contents/MacOS/${RECONSTRUCTED_BUNDLE_ID}`)).toBe(true);
    expect(isReconstructedProcessCommand("/Applications/Grok Bot.app/Contents/MacOS/Grok Bot")).toBe(false);
    expect(bundleIdFromInfoPlist(plist(RECONSTRUCTED_BUNDLE_ID))).toBe(RECONSTRUCTED_BUNDLE_ID);
  });

  it("keeps disabled reasons free of paths, tokens, and ports", () => {
    const isolated = reconstructedIsolatedDiscoveryPath("/Users/vincent", "darwin");
    for (const code of [
      "not-detected",
      "installed-not-running",
      "runtime-not-reconstructed",
      "discovery-unreadable",
      "non-loopback-refused",
      "process-dead",
      "health-unavailable",
      "identity-mismatch",
      "list-agents-unsupported",
      "send-prompt-unsupported",
    ] as const) {
      const reason = publicDisabledReason(code);
      expect(
        leaksSensitive(reason, [TOKEN, "/Users/vincent/.grokbot/gateway.json", isolated ?? ""]),
      ).toBe(false);
      expect(reason).not.toMatch(/127\.0\.0\.1:\d+/);
      expect(reason).not.toContain(TOKEN);
      expect(reason).not.toContain("gateway.json");
      expect(reason).not.toContain(".grokbot");
      expect(reason).not.toContain("sand-data");
      expect(reason).not.toContain("Application Support");
    }
  });

  it("lists isolated packaged then legacy discovery paths and nothing else", () => {
    expect(reconstructedDiscoveryPaths("/Users/vincent", "darwin")).toEqual([
      "/Users/vincent/Library/Application Support/Grok Bot 0.18 Reconstructed/sand-data/gateway.json",
      "/Users/vincent/.grokbot/gateway.json",
    ]);
    expect(reconstructedDiscoveryPaths("/home/vincent", "linux")).toEqual([
      "/home/vincent/.config/Grok Bot 0.18 Reconstructed/sand-data/gateway.json",
      "/home/vincent/.grokbot/gateway.json",
    ]);
    expect(reconstructedDiscoveryPaths("/Users/vincent", "win32")).toEqual([
      join("/Users/vincent", "AppData", "Roaming", "Grok Bot 0.18 Reconstructed", "sand-data", "gateway.json"),
      join("/Users/vincent", ".grokbot", "gateway.json"),
    ]);
    expect(reconstructedDiscoveryPaths("/Users/vincent", "freebsd")).toEqual([
      "/Users/vincent/.grokbot/gateway.json",
    ]);
    expect(reconstructedIsolatedDiscoveryPath("/Users/vincent", "darwin")).toBe(
      "/Users/vincent/Library/Application Support/Grok Bot 0.18 Reconstructed/sand-data/gateway.json",
    );
    expect(reconstructedDiscoveryPath("/Users/vincent")).toBe("/Users/vincent/.grokbot/gateway.json");
  });
});

describe("reconstructed session sanitization", () => {
  it("keeps id and label and drops host paths and avatars", () => {
    const sessions = sanitizeAgentSessions([
      {
        id: "bot-alpha",
        name: "Alpha",
        path: "/Users/someone/.grokbot/agents/bot-alpha/store.db",
        avatarDataUrl: "data:image/png;base64,secret",
        isActive: true,
        isRunning: false,
      },
      { id: "bad id", name: "Nope" },
      { id: ACTIVE_SESSION_ID, name: "Reserved" },
      { name: "missing-id" },
    ]);
    expect(sessions).toEqual([{ id: "bot-alpha", label: "Alpha", isRunning: false, isActive: true }]);
    expect(JSON.stringify(sessions)).not.toContain(".grokbot");
    expect(JSON.stringify(sessions)).not.toContain("avatarDataUrl");
    expect(sessionsToCatalog(sessions).options.map((option) => option.id)).toEqual([ACTIVE_SESSION_ID, "bot-alpha"]);
  });

  it("extracts assistant text after the matching user prompt", () => {
    expect(
      extractAssistantText(
        [
          { id: "u1", kind: "message", content: "hi" },
          { id: "a1", kind: "send-message", message: { type: "text", content: "old" } },
          { id: "u2", kind: "message", content: "later" },
          { id: "a2", kind: "send-message", message: { type: "text", content: "new" } },
        ],
        "later",
      ),
    ).toBe("new");
  });

  it("never treats a user prompt as assistant text", () => {
    expect(
      extractAssistantText(
        [
          { id: "u1", kind: "message", content: "hello reconstructed" },
          { id: "a1", kind: "send-message", message: { type: "text", content: "hello reconstructed" } },
        ],
        "hello reconstructed",
      ),
    ).toBe("");
  });
});

describe("reconstructed runtime detection", () => {
  it("reports not-detected when nothing is installed or running", async () => {
    const probe = await detectReconstructedRuntime(hostFrom({ homeDir: mkdtempSync(join(tmpdir(), "omb-recon-")) }));
    expect(probe).toEqual({ ok: false, code: "not-detected" });
  });

  it("reports installed-not-running for the reconstructed app bundle", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const apps = join(homeDir, "Applications");
    const appPath = join(apps, `${RECONSTRUCTED_APP_NAME}.app`);
    mkdirSync(join(appPath, "Contents"), { recursive: true });
    writeFileSync(join(appPath, "Contents", "Info.plist"), plist(RECONSTRUCTED_BUNDLE_ID));
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        applicationsDirs: [apps],
        existsDir: (path) => path === appPath,
        readText: (path) => (path.endsWith("Info.plist") ? plist(RECONSTRUCTED_BUNDLE_ID) : null),
      }),
    );
    expect(probe).toEqual({ ok: false, code: "installed-not-running" });
  });

  it("accepts com.anysphere.sand.reconstructed as the installed bundle id", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const apps = join(homeDir, "Applications");
    const appPath = join(apps, `${RECONSTRUCTED_APP_NAME}.app`);
    mkdirSync(join(appPath, "Contents"), { recursive: true });
    writeFileSync(join(appPath, "Contents", "Info.plist"), plist(RECONSTRUCTED_BUNDLE_ID));
    const gateway = await startFakeGateway();
    try {
      const record = JSON.stringify({
        port: gateway.port,
        pid: gateway.pid,
        startedAt: 1,
        scheme: "http",
        host: "127.0.0.1",
        token: TOKEN,
      });
      const probe = await detectReconstructedRuntime(
        hostFrom({
          homeDir,
          applicationsDirs: [apps],
          existsDir: (path) => path === appPath,
          readText: (path) => {
            if (path.endsWith("Info.plist")) return plist(RECONSTRUCTED_BUNDLE_ID);
            if (path === reconstructedDiscoveryPath(homeDir)) return record;
            return null;
          },
          isProcessAlive: (pid) => pid === gateway.pid,
          readProcessCommand: (pid) =>
            pid === gateway.pid ? `${RECONSTRUCTED_BUNDLE_ID}/Contents/MacOS/host-main` : null,
        }),
      );
      expect(probe.ok).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("refuses a non-loopback discovery record without fetching it", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    let fetched = 0;
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        isProcessAlive: () => true,
        readProcessCommand: () => RECONSTRUCTED_APP_NAME,
        readText: (path) =>
          path === reconstructedDiscoveryPath(homeDir)
            ? JSON.stringify({ port: 80, pid: 9, startedAt: 1, host: "8.8.8.8", token: TOKEN })
            : null,
        fetch: async () => {
          fetched += 1;
          throw new Error("should not fetch a public gateway");
        },
      }),
    );
    expect(probe).toEqual({ ok: false, code: "non-loopback-refused" });
    expect(fetched).toBe(0);
  });

  it("reports a precise reason when discovery JSON is unusable", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        readText: (path) => (path === reconstructedDiscoveryPath(homeDir) ? "{not-json" : null),
      }),
    );
    expect(probe).toEqual({ ok: false, code: "discovery-unreadable" });
  });

  it("does not treat official Grok Bot as reconstructed", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        isProcessAlive: () => true,
        readProcessCommand: () => "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot",
        readText: (path) =>
          path === reconstructedDiscoveryPath(homeDir)
            ? JSON.stringify({ port: 18765, pid: 22, startedAt: 1, host: "127.0.0.1", token: TOKEN })
            : null,
      }),
    );
    expect(probe).toEqual({ ok: false, code: "runtime-not-reconstructed" });
  });

  it("reports process-dead when discovery names a missing process", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        isProcessAlive: () => false,
        readText: (path) =>
          path === reconstructedDiscoveryPath(homeDir)
            ? JSON.stringify({ port: 18765, pid: 22, startedAt: 1, host: "127.0.0.1", token: TOKEN })
            : null,
      }),
    );
    expect(probe).toEqual({ ok: false, code: "process-dead" });
  });

  it("discovers the isolated packaged Electron userData record", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const isolated = reconstructedIsolatedDiscoveryPath(homeDir, "darwin");
    expect(isolated).toBeTruthy();
    const gateway = await startFakeGateway();
    try {
      const record = JSON.stringify({
        port: gateway.port,
        pid: gateway.pid,
        startedAt: 1,
        scheme: "http",
        host: "127.0.0.1",
        token: TOKEN,
      });
      const probe = await detectReconstructedRuntime(
        hostFrom({
          homeDir,
          readText: (path) => (path === isolated ? record : null),
          isProcessAlive: (pid) => pid === gateway.pid,
          readProcessCommand: (pid) =>
            pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null,
        }),
      );
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      expect(probe.origin).toBe(gateway.origin);
      expect(JSON.stringify(probe.sessions)).not.toContain("sand-data");
      expect(JSON.stringify(probe.sessions)).not.toContain(isolated);
    } finally {
      await gateway.close();
    }
  });

  it("prefers the isolated packaged record over a leftover legacy file", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const isolated = reconstructedIsolatedDiscoveryPath(homeDir, "darwin");
    expect(isolated).toBeTruthy();
    const gateway = await startFakeGateway();
    try {
      const isolatedRecord = JSON.stringify({
        port: gateway.port,
        pid: gateway.pid,
        startedAt: 1,
        scheme: "http",
        host: "127.0.0.1",
        token: TOKEN,
      });
      const staleLegacy = JSON.stringify({
        port: 18_765,
        pid: 9999,
        startedAt: 1,
        scheme: "http",
        host: "127.0.0.1",
        token: "stale-legacy-token",
      });
      const probe = await detectReconstructedRuntime(
        hostFrom({
          homeDir,
          readText: (path) => {
            if (path === isolated) return isolatedRecord;
            if (path === reconstructedDiscoveryPath(homeDir)) return staleLegacy;
            return null;
          },
          isProcessAlive: (pid) => pid === gateway.pid,
          readProcessCommand: (pid) =>
            pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null,
        }),
      );
      expect(probe.ok).toBe(true);
      if (!probe.ok) return;
      expect(probe.origin).toBe(gateway.origin);
      expect(probe.discovery.pid).toBe(gateway.pid);
    } finally {
      await gateway.close();
    }
  });

  it("fails closed on a present unreadable isolated record instead of using legacy", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const isolated = reconstructedIsolatedDiscoveryPath(homeDir, "darwin");
    expect(isolated).toBeTruthy();
    let fetched = 0;
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        isProcessAlive: () => true,
        readProcessCommand: () => RECONSTRUCTED_APP_NAME,
        readText: (path) => {
          if (path === isolated) return "{not-json";
          if (path === reconstructedDiscoveryPath(homeDir)) {
            return JSON.stringify({
              port: 18_765,
              pid: 22,
              startedAt: 1,
              host: "127.0.0.1",
              token: TOKEN,
            });
          }
          return null;
        },
        fetch: async () => {
          fetched += 1;
          throw new Error("should not fetch after an unreadable isolated record");
        },
      }),
    );
    expect(probe).toEqual({ ok: false, code: "discovery-unreadable" });
    expect(fetched).toBe(0);
  });

  it("fails closed on a non-loopback isolated record instead of using legacy", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const isolated = reconstructedIsolatedDiscoveryPath(homeDir, "darwin");
    expect(isolated).toBeTruthy();
    let fetched = 0;
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        isProcessAlive: () => true,
        readProcessCommand: () => RECONSTRUCTED_APP_NAME,
        readText: (path) => {
          if (path === isolated) {
            return JSON.stringify({ port: 80, pid: 9, startedAt: 1, host: "8.8.8.8", token: TOKEN });
          }
          if (path === reconstructedDiscoveryPath(homeDir)) {
            return JSON.stringify({
              port: 18_765,
              pid: 22,
              startedAt: 1,
              host: "127.0.0.1",
              token: TOKEN,
            });
          }
          return null;
        },
        fetch: async () => {
          fetched += 1;
          throw new Error("should not fetch a public gateway");
        },
      }),
    );
    expect(probe).toEqual({ ok: false, code: "non-loopback-refused" });
    expect(fetched).toBe(0);
  });
});

describe("reconstructed provider adapter", () => {
  const servers: FakeGateway[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  async function liveDriver(gateway: FakeGateway) {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const record = JSON.stringify({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: 1,
      scheme: "http",
      host: "127.0.0.1",
      token: TOKEN,
    });
    const driver = createGrokReconstructedDriver({
      homeDir,
      platform: "darwin",
      applicationsDirs: [],
      existsDir: () => false,
      readText: (path) => (path === reconstructedDiscoveryPath(homeDir) ? record : null),
      isProcessAlive: (pid) => pid === gateway.pid,
      readProcessCommand: (pid) => (pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null),
      delay: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });
    return driver.create({
      instanceId: "grokReconstructed",
      displayName: "Grok Reconstructed",
      environment: {},
      enabled: true,
      config: {},
    });
  }

  it("registers as a custom reconstructed engine", () => {
    const driver = createGrokReconstructedDriver();
    expect(driver.driverKind).toBe(DRIVER_KIND);
    expect(driver.metadata.displayName).toBe("Grok Reconstructed");
    expect(driver.metadata.access).toBe("custom");
    expect(driver.defaultConfig()).toEqual({});
  });

  it("snapshots an isolated packaged gateway without leaking discovery", async () => {
    const gateway = await startFakeGateway();
    servers.push(gateway);
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const isolated = reconstructedIsolatedDiscoveryPath(homeDir, "darwin");
    expect(isolated).toBeTruthy();
    const record = JSON.stringify({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: 1,
      scheme: "http",
      host: "127.0.0.1",
      token: TOKEN,
    });
    const driver = createGrokReconstructedDriver({
      homeDir,
      platform: "darwin",
      applicationsDirs: [],
      existsDir: () => false,
      readText: (path) => (path === isolated ? record : null),
      isProcessAlive: (pid) => pid === gateway.pid,
      readProcessCommand: (pid) =>
        pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null,
    });
    const instance = await driver.create({
      instanceId: "grokReconstructed",
      displayName: "Grok Reconstructed",
      environment: {},
      enabled: true,
      config: {},
    });
    try {
      const snapshot = await instance.snapshot();
      expect(snapshot).toEqual({
        state: "available",
        authenticated: true,
        version: "0.18-reconstructed",
      });
      const publicJson = JSON.stringify({ snapshot, models: instance.models });
      expect(publicJson).not.toContain("gateway.json");
      expect(publicJson).not.toContain(".grokbot");
      expect(publicJson).not.toContain("sand-data");
      expect(publicJson).not.toContain("Application Support");
      expect(publicJson).not.toContain(TOKEN);
      expect(publicJson).not.toContain(String(gateway.port));
      expect(publicJson).not.toContain(isolated);
    } finally {
      await instance.dispose();
    }
  });

  it("snapshots unavailable without leaking local discovery", async () => {
    const driver = createGrokReconstructedDriver({
      homeDir: mkdtempSync(join(tmpdir(), "omb-recon-")),
      applicationsDirs: [],
      existsDir: () => false,
      readText: () => null,
    });
    const instance = await driver.create({
      instanceId: "grokReconstructed",
      displayName: "Grok Reconstructed",
      environment: {},
      enabled: true,
      config: {},
    });
    const snapshot = await instance.snapshot();
    expect(snapshot.state).toBe("unavailable");
    expect(snapshot.reason).toBe(publicDisabledReason("not-detected"));
    expect(JSON.stringify(snapshot)).not.toContain("gateway.json");
    expect(JSON.stringify(snapshot)).not.toContain(".grokbot");
    expect(JSON.stringify(snapshot)).not.toContain("sand-data");
    expect(JSON.stringify(snapshot)).not.toContain("Application Support");
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    await instance.dispose();
  });

  it("discovers reconstructed bots and streams a sendPrompt turn over loopback", async () => {
    const gateway = await startFakeGateway();
    servers.push(gateway);
    const instance = await liveDriver(gateway);
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      const snapshot = await instance.snapshot();
      expect(snapshot).toEqual({
        state: "available",
        authenticated: true,
        version: "0.18-reconstructed",
      });
      expect(instance.models.options.map((option) => option.id)).toEqual([ACTIVE_SESSION_ID, "bot-alpha"]);
      expect(JSON.stringify(instance.models)).not.toContain(".grokbot");
      expect(JSON.stringify(instance.models)).not.toContain("avatarDataUrl");

      const { turnId } = await instance.adapter.sendTurn({
        threadId: "thread-1",
        text: "hello reconstructed",
        model: "bot-alpha",
      });
      await recorder.until((event) => event.type === "turn.completed" && event.ok === true);

      expect(gateway.seen.unauthorized).toBe(0);
      expect(gateway.seen.origins).toEqual([]);
      expect(gateway.seen.slimAvatars).toBeGreaterThan(0);
      expect(gateway.seen.paths.some((path) => path === "POST /api/sendPrompt")).toBe(true);
      expect(gateway.seen.paths.some((path) => path.startsWith("GET /health"))).toBe(true);
      expect(gateway.seen.sendPrompts).toEqual([{ prompt: "hello reconstructed", agentId: "bot-alpha" }]);
      expect(JSON.stringify(gateway.seen.sendPrompts)).not.toContain("attachmentPaths");
      expect(recorder.events.map((event) => event.type)).toEqual([
        "turn.started",
        "session.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      expect(recorder.events.every((event) => event.turnId === turnId && event.provider === DRIVER_KIND)).toBe(true);
      expect(recorder.events.find((event) => event.type === "item.completed")).toMatchObject({
        itemType: "assistant_text",
        text: "hello from reconstructed",
      });
      expect(instance.adapter.capabilities.agentsMcp).toBe(false);
      expect(instance.adapter.capabilities.computerMcp).toBe(false);
      expect(instance.adapter.capabilities.localComputerMcp).toBe(false);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("does not call undocumented gateway routes", async () => {
    const gateway = await startFakeGateway();
    servers.push(gateway);
    const instance = await liveDriver(gateway);
    try {
      await instance.refreshModels?.();
      const recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({ threadId: "thread-2", text: "ping", model: "bot-alpha" });
      await recorder.until((event) => event.type === "turn.completed");
      recorder.stop();
      const allowed = new Set([
        "GET /health",
        "POST /api/listAgents",
        "POST /api/sendPrompt",
        "POST /api/getAgentTranscriptTail",
        "GET /vbot/v1",
      ]);
      for (const path of gateway.seen.paths) expect(allowed.has(path)).toBe(true);
      expect(gateway.seen.paths.some((path) => path.includes("/events"))).toBe(false);
    } finally {
      await instance.dispose();
    }
  });

  it("reports only verified coordinator capabilities after detection", async () => {
    const gateway = await startFakeGateway();
    servers.push(gateway);
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const record = JSON.stringify({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: 1,
      scheme: "http",
      host: "127.0.0.1",
      token: TOKEN,
    });
    const probe = await detectReconstructedRuntime(
      hostFrom({
        homeDir,
        readText: (path) => (path === reconstructedDiscoveryPath(homeDir) ? record : null),
        isProcessAlive: (pid) => pid === gateway.pid,
        readProcessCommand: (pid) =>
          pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null,
      }),
    );
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.capabilities).toEqual({
      health: true,
      listAgents: true,
      sendPrompt: false,
      events: false,
      transcriptTail: false,
      vbotInterop: false,
      steer: false,
      stop: false,
      selectHostRouter: false,
    });
    expect(probe.origin).toBe(gateway.origin);
    expect(gateway.seen.paths).toEqual(["GET /health", "POST /api/listAgents", "GET /vbot/v1"]);
    expect(JSON.stringify(probe.sessions)).not.toContain(".grokbot");
  });

  it("keeps the engine unavailable for precise gateway failures", async () => {
    const cases = [
      { options: { healthOk: false }, code: "health-unavailable" },
      { options: { healthPid: 9999 }, code: "identity-mismatch" },
      { options: { listAgents: false }, code: "list-agents-unsupported" },
    ] as const;
    for (const { options, code } of cases) {
      const gateway = await startFakeGateway({ pid: 4242, ...options });
      servers.push(gateway);
      const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
      const probe = await detectReconstructedRuntime(
        hostFrom({
          homeDir,
          readText: (path) =>
            path === reconstructedDiscoveryPath(homeDir)
              ? JSON.stringify({
                  port: gateway.port,
                  pid: gateway.pid,
                  startedAt: 1,
                  scheme: "http",
                  host: "127.0.0.1",
                  token: TOKEN,
                })
              : null,
          isProcessAlive: (pid) => pid === gateway.pid,
          readProcessCommand: (pid) =>
            pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null,
        }),
      );
      expect(probe).toEqual({ ok: false, code });
    }
  });

  it("fails a send with a public reason when sendPrompt is missing", async () => {
    const gateway = await startFakeGateway({ sendPrompt: false });
    servers.push(gateway);
    const instance = await liveDriver(gateway);
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "thread-missing-send",
        text: "hello reconstructed",
        model: "bot-alpha",
      });
      await recorder.until((event) => event.type === "turn.completed" && event.ok === false);
      const error = recorder.events.find((event) => event.type === "runtime.error");
      expect(error).toMatchObject({
        type: "runtime.error",
        turnId,
        message: publicDisabledReason("send-prompt-unsupported"),
      });
      expect(JSON.stringify(recorder.events)).not.toContain(TOKEN);
      expect(JSON.stringify(recorder.events)).not.toContain(String(gateway.port));
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("fails an empty or timed-out reply instead of completing ok=true", async () => {
    const gateway = await startFakeGateway({ assistantReply: false });
    servers.push(gateway);
    let clock = 1_000_000;
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const record = JSON.stringify({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: 1,
      scheme: "http",
      host: "127.0.0.1",
      token: TOKEN,
    });
    const driver = createGrokReconstructedDriver({
      homeDir,
      platform: "darwin",
      applicationsDirs: [],
      existsDir: () => false,
      readText: (path) => (path === reconstructedDiscoveryPath(homeDir) ? record : null),
      isProcessAlive: (pid) => pid === gateway.pid,
      readProcessCommand: (pid) => (pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null),
      now: () => clock,
      delay: async () => {
        clock += 15_000;
      },
    });
    const instance = await driver.create({
      instanceId: "grokReconstructed",
      displayName: "Grok Reconstructed",
      environment: {},
      enabled: true,
      config: {},
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.refreshModels?.();
      await instance.adapter.sendTurn({
        threadId: "thread-empty",
        text: "hello reconstructed",
        model: "bot-alpha",
      });
      await recorder.until((event) => event.type === "turn.completed");
      const completed = recorder.events.find((event) => event.type === "turn.completed");
      expect(completed).toMatchObject({ ok: false, stopReason: "error" });
      expect(recorder.events.some((event) => event.type === "item.completed")).toBe(false);
      expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(true);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

describe("reconstructed vbot interop client", () => {
  const servers: FakeGateway[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  async function liveRuntime(gateway: FakeGateway) {
    const homeDir = mkdtempSync(join(tmpdir(), "omb-recon-"));
    const record = JSON.stringify({
      port: gateway.port,
      pid: gateway.pid,
      startedAt: 1,
      scheme: "http",
      host: "127.0.0.1",
      token: TOKEN,
    });
    const host = hostFrom({
      homeDir,
      readText: (path) => (path === reconstructedDiscoveryPath(homeDir) ? record : null),
      isProcessAlive: (pid) => pid === gateway.pid,
      readProcessCommand: (pid) =>
        pid === gateway.pid ? `${RECONSTRUCTED_APP_NAME}.app/Contents/MacOS/host-main` : null,
    });
    const probe = await detectReconstructedRuntime(host);
    expect(probe.ok).toBe(true);
    if (!probe.ok) throw new Error("expected reconstructed runtime");
    return { host, runtime: probe };
  }

  it("reads bots, groups, providers, router, and activity without leaking secrets", async () => {
    const gateway = await startFakeGateway({ vbot: true });
    servers.push(gateway);
    const { host, runtime } = await liveRuntime(gateway);
    const [bots, groups, providers, router, activity] = await Promise.all([
      fetchVbotBots(host, runtime),
      fetchVbotGroups(host, runtime),
      fetchVbotProviders(host, runtime),
      fetchVbotRouter(host, runtime),
      fetchVbotActivity(host, runtime, "bot-alpha"),
    ]);
    expect(bots).toEqual([{ id: "bot-alpha", label: "Alpha", isActive: true, isRunning: false }]);
    expect(groups).toEqual([{ id: "group-ops", label: "Ops", memberIds: ["bot-alpha"] }]);
    expect(router.selected).toEqual({ provider: "cursor", modelId: "grok-4.5", scope: "host" });
    expect(providers.currentProvider).toBe("cursor");
    expect(activity).toMatchObject({ botId: "bot-alpha", activityKind: "idle", hostBusy: false });
    const wire = JSON.stringify({ bots, groups, providers, router, activity });
    expect(leaksSensitive(wire, [TOKEN, String(gateway.port)])).toBe(false);
    expect(runtime.capabilities).toMatchObject({
      vbotInterop: true,
      sendPrompt: true,
      steer: true,
      stop: true,
    });
  });

  it("sets the host Cursor model and submits, steers, and stops a selected bot", async () => {
    const gateway = await startFakeGateway({ vbot: true });
    servers.push(gateway);
    const { host, runtime } = await liveRuntime(gateway);
    const router = await setVbotRouter(host, runtime, { provider: "cursor", modelId: "grok-4.6" });
    expect(router.selected).toEqual({ provider: "cursor", modelId: "grok-4.6", scope: "host" });
    expect(gateway.seen.routerPuts).toEqual([{ provider: "cursor", modelId: "grok-4.6" }]);
    await expect(
      setVbotRouter(host, runtime, { provider: "claude-code", modelId: "claude-opus" }),
    ).rejects.toMatchObject({ code: "unsupported_action", action: "provider_model_select", status: 409 });
    const sent = await submitVbotTurn(host, runtime, "bot-alpha", { prompt: "hello reconstructed" }, false);
    const steered = await submitVbotTurn(host, runtime, "bot-alpha", { prompt: "steer now" }, true);
    const stopped = await stopVbotBot(host, runtime, "bot-alpha");
    expect(sent).toEqual({ accepted: true, botId: "bot-alpha", steered: false });
    expect(steered).toEqual({ accepted: true, botId: "bot-alpha", steered: true });
    expect(stopped).toEqual({ botId: "bot-alpha", stopped: true });
    expect(gateway.seen.turns).toEqual([{ prompt: "hello reconstructed" }]);
    expect(gateway.seen.steers).toEqual([{ prompt: "steer now" }]);
    expect(gateway.seen.stops).toEqual(["bot-alpha"]);
    expect(JSON.stringify(gateway.seen)).not.toContain(TOKEN);
  });

  it("returns a typed stop failure when the runner interrupt is unbound", async () => {
    const gateway = await startFakeGateway({ vbot: true, stop: false });
    servers.push(gateway);
    const { host, runtime } = await liveRuntime(gateway);
    expect(runtime.capabilities.stop).toBe(false);
    await expect(stopVbotBot(host, runtime, "bot-alpha")).rejects.toMatchObject({
      code: "unsupported_action",
      action: "stop",
      status: 409,
    });
  });
});
