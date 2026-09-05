import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { explainApproval, reviewApproval, type ApprovalReviewInput } from "./approval-explainer.ts";
import {
  approvalReviewerSelection,
  autoSelectApprovalReviewer,
  buildApprovalReviewerCatalog,
  buildApprovalReviewerStatus,
  buildApprovalReviewPrompt,
  catalogContainsSecrets,
  detectCliReviewCapability,
  codexHelpSupportsIsolatedReview,
  extractReviewedJson,
  isAllowedReviewerUrl,
  parseApprovalReviewerPatch,
  reviewDriverFamily,
  reviewerCacheIdentity,
  resolveEffectiveReviewerSelection,
  resolveStoredSelection,
  sanitizeApprovalReviewerStatus,
  shouldReviewApproval,
  validateReviewerSelection,
  XAI_REVIEW_INSTANCE_ID,
} from "./approval-reviewer.ts";
import { bindApprovalReviewer } from "./approval-reviewer-bind.ts";
import {
  chatCompletionReviewPayload,
  createDirectReviewer,
  readResponseTextCapped,
  reviewEndpoint,
} from "./approval-reviewer-direct.ts";
import {
  assertIsolatedReviewArgs,
  claudeIsolatedReviewArgs,
  codexIsolatedReviewArgs,
  createCliReviewer,
  cursorIsolatedReviewArgs,
  isolatedReviewEnv,
  parseIsolatedCliOutput,
  probeCliHelp,
  validateReviewerCli,
  waitForChildExit,
} from "./approval-reviewer-cli.ts";
import {
  assertCodexNoToolsPayload,
  createCodexOAuthReviewer,
  parseCodexSseFinalText,
  readCodexOAuthCredentialsSync,
  refreshCodexOAuthCredentials,
} from "./approval-reviewer-codex.ts";

const CLAUDE_HELP = `
  -p, --print  Print response and exit
  --tools <tools...>  Use "" to disable all tools, "default" to use all tools
  --strict-mcp-config  Only use MCP servers from --mcp-config
  --no-session-persistence  Do not persist the session
`;

const CURSOR_HELP = `
  -p, --print  Print responses to console
  --mode <mode>  plan: read-only/planning. ask: Q&A style for explanations and questions (read-only).
  --sandbox <mode>  Explicitly enable or disable sandbox mode (choices: "enabled", "disabled")
`;

const CODEX_HELP = `
  exec  Run Codex non-interactively
  -s, --sandbox <SANDBOX_MODE>
  read-only
  --ephemeral
  --ignore-user-config
  --skip-git-repo-check
  --json
`;

const GROK_HELP = `
  -p, --single <PROMPT>
  --tools <TOOLS>  Built-in tools to allow
`;

function codexSseBody(text: string, options: { itemType?: string; finalText?: string } = {}): string {
  const finalText = options.finalText ?? text;
  const itemType = options.itemType ?? "message";
  const events = [
    ["response.created", { type: "response.created", response: { id: "resp_test" } }],
    ["response.in_progress", { type: "response.in_progress" }],
    ["response.output_item.added", { type: "response.output_item.added", item: { type: itemType, role: "assistant", content: [] } }],
    ["response.content_part.added", { type: "response.content_part.added", part: { type: "output_text", text: "" } }],
    ["response.output_text.delta", { type: "response.output_text.delta", delta: text }],
    ["response.output_text.done", { type: "response.output_text.done", text: finalText }],
    ["response.content_part.done", { type: "response.content_part.done", part: { type: "output_text", text: finalText } }],
    ["response.output_item.done", { type: "response.output_item.done", item: { type: itemType, role: "assistant", content: [{ type: "output_text", text: finalText }] } }],
    ["response.completed", { type: "response.completed", response: { status: "completed", output: [{ type: itemType, role: "assistant", content: [{ type: "output_text", text: finalText }] }] } }],
  ] as const;
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe("approval reviewer selection", () => {
  it("defaults to when-unclear and stores only nonsecret selection", () => {
    expect(approvalReviewerSelection({})).toEqual({ mode: "when-unclear" });
    expect(approvalReviewerSelection({ approvalReviewer: { mode: "always", instanceId: "openaiCompat", model: "llama" } })).toEqual({
      mode: "always",
      instanceId: "openaiCompat",
      model: "llama",
    });
  });

  it("does not select a provider when none was explicitly saved", () => {
    expect(buildApprovalReviewerStatus(
      {},
      [{
        instanceId: "codex",
        driverKind: "codex",
        models: { options: [{ id: "gpt-5.6-sol", label: "Sol" }] },
        snapshot: { state: "available", authenticated: true },
        cliDefault: "codex",
      }],
      {},
      { helpTextByCli: { codex: CODEX_HELP }, installedByCli: { codex: true } },
    ).selection).toBeNull();
  });

  it("reviews only when the mode asks for it", () => {
    const clear = { confidence: "high" as const };
    const unclear = { confidence: "low" as const };
    expect(shouldReviewApproval("off", unclear)).toBe(false);
    expect(shouldReviewApproval("when-unclear", clear)).toBe(false);
    expect(shouldReviewApproval("when-unclear", unclear)).toBe(true);
    expect(shouldReviewApproval("always", clear)).toBe(true);
  });

  it("rejects extra patch fields and unpaired selection", () => {
    expect(parseApprovalReviewerPatch({ mode: "off", xai: { key: "secret" } }).ok).toBe(false);
    expect(parseApprovalReviewerPatch({ mode: "always", instanceId: "openaiCompat" }).ok).toBe(false);
    expect(parseApprovalReviewerPatch({ mode: "always", instanceId: "openaiCompat", model: "llama" })).toEqual({
      ok: true,
      patch: { mode: "always", instanceId: "openaiCompat", model: "llama" },
    });
  });
});

describe("approval reviewer catalog", () => {
  it("lists direct providers as available when keys exist and keeps OAuth lanes honest", () => {
    const catalog = buildApprovalReviewerCatalog(
      [
        {
          instanceId: "openaiCompat",
          driverKind: "openai-compat",
          displayName: "OpenAI-compatible",
          models: { default: "llama", options: [{ id: "llama", label: "Llama" }] },
          snapshot: { state: "available" },
        },
        {
          instanceId: "claude",
          driverKind: "claudeAgent",
          displayName: "Claude",
          cliDefault: "claude",
          models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }] },
          snapshot: { state: "available", authenticated: true },
        },
        {
          instanceId: "cursor",
          driverKind: "cursorAgent",
          displayName: "Cursor",
          cliDefault: "cursor-agent",
          models: { default: "auto", options: [{ id: "auto", label: "Auto" }] },
          snapshot: { state: "available", authenticated: true },
        },
        {
          instanceId: "codex",
          driverKind: "codex",
          displayName: "Codex",
          cliDefault: "codex",
          models: { default: "gpt-5.4", options: [{ id: "gpt-5.4", label: "GPT-5.4" }] },
          snapshot: { state: "available", authenticated: true },
        },
        {
          instanceId: "grok",
          driverKind: "grokAgent",
          displayName: "Grok Auth",
          cliDefault: "grok",
          models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok 4.6" }] },
          snapshot: { state: "available", authenticated: true },
        },
      ],
      { openaiCompat: { key: "sk-or-v1-test", url: "https://openrouter.ai/api/v1" }, xai: { key: "xai-test" } },
      {
        helpTextByCli: { claude: CLAUDE_HELP, "cursor-agent": CURSOR_HELP, codex: CODEX_HELP, grok: GROK_HELP },
        installedByCli: { claude: true, "cursor-agent": true, codex: true, grok: true },
      },
    );

    const byId = Object.fromEntries(catalog.map((row) => [row.instanceId, row]));
    expect(byId.openaiCompat).toMatchObject({ available: true, configured: true, reason: null });
    expect(byId[XAI_REVIEW_INSTANCE_ID]).toMatchObject({ available: true, configured: true, id: "xai" });
    expect(byId.claude).toMatchObject({ available: true, configured: true });
    expect(byId.cursor).toMatchObject({ available: false, configured: true });
    expect(byId.cursor?.reason).toMatch(/unavailable|tool-free/i);
    expect(byId.codex).toMatchObject({ available: false, configured: true });
    expect(byId.codex?.reason).toMatch(/unavailable|tool-free/i);
    expect(byId.grok?.available).toBe(false);
    expect(byId.grok?.reason).toMatch(/MCP/i);
    expect(catalogContainsSecrets(buildApprovalReviewerStatus(
      { approvalReviewer: { mode: "when-unclear", instanceId: "openaiCompat", model: "llama" } },
      [{ instanceId: "openaiCompat", driverKind: "openai-compat", models: { options: [{ id: "llama", label: "Llama" }] } }],
      { openaiCompat: { key: "sk-secret", url: "https://example.invalid/v1" } },
    ))).toBe(false);
  });

  it("rejects the Codex OAuth lane even when its CLI advertises read-only flags", () => {
    const providers = buildApprovalReviewerCatalog(
      [{
        instanceId: "codex",
        driverKind: "codex",
        models: { options: [{ id: "gpt-5.4", label: "GPT" }] },
        snapshot: { authenticated: true, state: "available" },
        cliDefault: "codex",
      }],
      {},
      { helpTextByCli: { codex: CODEX_HELP }, installedByCli: { codex: true } },
    );
    expect(validateReviewerSelection({ mode: "always", instanceId: "codex", model: "gpt-5.4" }, providers).ok).toBe(false);
  });

  it("marks Codex OAuth available only after the server proves the existing login", () => {
    const providers = buildApprovalReviewerCatalog(
      [{
        instanceId: "codex",
        driverKind: "codex",
        models: { options: [{ id: "gpt-5.4", label: "GPT-5.4" }] },
        snapshot: { authenticated: true, state: "available" },
      }],
      {},
      { codexOAuthAvailable: true },
    );
    expect(providers[0]).toMatchObject({ available: true, configured: true, reason: null, id: "openai" });
    expect(validateReviewerSelection({ mode: "always", instanceId: "codex", model: "gpt-5.4" }, providers)).toEqual({ ok: true });
  });
});

describe("CLI isolation detection", () => {
  it("accepts only Claude empty-tools print and refuses subscription CLI lanes without proof", () => {
    expect(detectCliReviewCapability("claude", CLAUDE_HELP).kind).toBe("supported");
    expect(detectCliReviewCapability("cursor", CURSOR_HELP).kind).toBe("unavailable");
    expect(codexHelpSupportsIsolatedReview(CODEX_HELP)).toBe(false);
    expect(detectCliReviewCapability("codex", CODEX_HELP).kind).toBe("unavailable");
    expect(detectCliReviewCapability("grok-auth", GROK_HELP).kind).toBe("unavailable");
    expect(reviewDriverFamily("claudeAgent", "claude")).toBe("claude");
    expect(reviewDriverFamily("cursorAgent", "cursor")).toBe("cursor");
    expect(reviewDriverFamily("codex", "codex")).toBe("codex");
    expect(reviewDriverFamily("grokAgent", "grok")).toBe("grok-auth");
    expect(reviewDriverFamily("grok", XAI_REVIEW_INSTANCE_ID)).toBe("xai");
  });

  it("builds Claude isolated argv and rejects unsupported subscription CLIs", () => {
    const prompt = "review this";
    const claude = claudeIsolatedReviewArgs(prompt, "claude-haiku-4-5");
    assertIsolatedReviewArgs("claude", claude);
    expect(claude).toContain("--tools");
    expect(claude[claude.indexOf("--tools") + 1]).toBe("");
    expect(claude).toContain("--strict-mcp-config");
    expect(claude).toContain("--no-session-persistence");
    expect(claude).not.toContain("--mcp-config");
    expect(() => cursorIsolatedReviewArgs(prompt, "auto")).toThrow(/unavailable|tool-free/i);
    expect(() => codexIsolatedReviewArgs(prompt, "gpt-5.6-sol")).toThrow(/unavailable|tool-free/i);
    expect(() => assertIsolatedReviewArgs("cursor", [])).toThrow(/unavailable|tool-free/i);
    expect(() => assertIsolatedReviewArgs("codex", [])).toThrow(/unavailable|tool-free/i);
    const env = isolatedReviewEnv("claude", {
      ANTHROPIC_API_KEY: "sk-ant",
      XAI_API_KEY: "xai",
      CURSOR_API_KEY: "cursor",
      CURSOR_AUTH_TOKEN: "cursor-auth",
      GH_TOKEN: "gh-secret",
      DATABASE_URL: "postgres://secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      HOME: "/tmp/home",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HOME).toBe("/tmp/home");
  });
});

describe("direct provider payloads", () => {
  it("sends a no-tools one-shot JSON payload and never includes the key in the body", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const reviewer = createDirectReviewer({
      url: "https://openrouter.example/api/v1",
      apiKey: "sk-secret-key",
      model: "llama",
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            purpose: "Reads STAFF.md and OPEN-GROK-ROUTING-RUNBOOK.md",
            change: "Nothing; read-only",
            where: "STAFF.md on Mac mini",
            risk: "low",
          }) } }],
        }), { status: 200 });
      },
    });
    const deterministic = explainApproval(
      "run_on_bridge",
      "printf '%s\\n' '=== STAFF ==='; sed -n '1,180p' STAFF.md",
      "Mac mini",
    );
    const value = await reviewer({
      tool: "run_on_bridge",
      command: "sed -n '1,180p' STAFF.md",
      host: "Mac mini",
      deterministic,
    }, new AbortController().signal);
    expect(value).toMatchObject({ purpose: expect.stringContaining("STAFF.md") });
    expect(seen[0]?.url).toBe("https://openrouter.example/api/v1/chat/completions");
    const payload = JSON.parse(seen[0]?.body ?? "{}");
    expect(payload.tools).toBeUndefined();
    expect(payload.functions).toBeUndefined();
    expect(payload.stream).toBe(false);
    expect(payload.body).toBeUndefined();
    expect(seen[0]?.body).not.toContain("sk-secret-key");
    expect(chatCompletionReviewPayload("llama", "hi")).not.toHaveProperty("tools");
  });
});

describe("Codex OAuth reviewer", () => {
  function tempCodexHome(): string {
    return mkdtempSync(join(tmpdir(), "omb-codex-auth-test-"));
  }

  function writeAuth(home: string, accessToken: string): void {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-secret",
        id_token: "id-secret",
        account_id: "account-123",
      },
    }));
    chmodSync(join(home, "auth.json"), 0o600);
  }

  function fakeAppServer(
    onAccountRead: () => void,
    seen: string[],
  ): import("node:child_process").ChildProcess {
    const child = new EventEmitter() as import("node:child_process").ChildProcess & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        seen.push(line);
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (message.method === "initialize") {
          child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        } else if (message.method === "account/read") {
          onAccountRead();
          child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { account: null } })}\n`);
        }
      }
    });
    return child;
  }

  it("reads only a valid owner-readable access token and never exposes refresh state", () => {
    const home = tempCodexHome();
    try {
      const accessToken = "header.payload.signature";
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-secret",
          id_token: "id-secret",
          account_id: "account-123",
        },
      }));
      chmodSync(join(home, "auth.json"), 0o600);
      const credentials = readCodexOAuthCredentialsSync({ CODEX_HOME: home });
      expect(credentials).toEqual({ accessToken, accountId: "account-123" });
      expect(JSON.stringify(credentials)).not.toContain("refresh-secret");
      chmodSync(join(home, "auth.json"), 0o644);
      expect(readCodexOAuthCredentialsSync({ CODEX_HOME: home })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refreshes an expired login through the official account/read path", async () => {
    const home = tempCodexHome();
    try {
      const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
      writeAuth(home, expired);
      const seen: string[] = [];
      let launches = 0;
      const refreshed = `fresh.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url")}.signature`;
      const result = await refreshCodexOAuthCredentials({
        env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH },
        spawn: (_cli, args, options) => {
          launches += 1;
          expect(args).toEqual(["app-server", "--listen", "stdio://"]);
          expect(options.env?.CODEX_HOME).toBe(home);
          return fakeAppServer(() => writeAuth(home, refreshed), seen) as never;
        },
      });
      expect(result).toEqual({ accessToken: refreshed, accountId: "account-123" });
      expect(launches).toBe(1);
      expect(seen.join(" ")).not.toContain("refresh-secret");
      expect(seen.join(" ")).not.toContain("cat README");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the provider unavailable when an expired login cannot be refreshed", () => {
    const home = tempCodexHome();
    try {
      const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
      writeAuth(home, expired);
      expect(readCodexOAuthCredentialsSync({ CODEX_HOME: home })).toBeNull();
      const providers = buildApprovalReviewerCatalog(
        [{
          instanceId: "codex",
          driverKind: "codex",
          snapshot: { state: "available", authenticated: true },
          models: { options: [{ id: "gpt-5.6-sol", label: "Sol" }] },
        }],
        {},
        { codexOAuthAvailable: false },
      );
      expect(providers[0]).toMatchObject({ available: false, configured: true });
      expect(providers[0]?.reason).toMatch(/unavailable|refresh/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes concurrent refreshes and reports failure without token material", async () => {
    const home = tempCodexHome();
    try {
      const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
      writeAuth(home, expired);
      const seen: string[] = [];
      let launches = 0;
      const spawn = (_cli: string, _args: string[], _options: unknown) => {
        launches += 1;
        return fakeAppServer(() => {}, seen) as never;
      };
      const options = { env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH }, spawn };
      const [a, b] = await Promise.all([
        refreshCodexOAuthCredentials(options),
        refreshCodexOAuthCredentials(options),
      ]);
      expect(a).toBeNull();
      expect(b).toBeNull();
      expect(launches).toBe(1);
      expect(seen.join(" ")).not.toContain("refresh-secret");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("re-reads auth.json before every bound review instead of retaining a token", async () => {
    const home = tempCodexHome();
    try {
      writeAuth(home, "old-access-token");
      const headers: string[] = [];
      const reviewer = createCodexOAuthReviewer({
        model: "gpt-5.6-sol",
        env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH },
        fetchImpl: async (_url, init) => {
          headers.push(new Headers(init?.headers).get("authorization") ?? "");
          const text = JSON.stringify({
            purpose: "Reads the requested file",
            change: "Nothing; read-only",
            where: "README.md on Mac mini",
            risk: "low",
          });
          return new Response(codexSseBody(text), { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      });
      const input = {
        tool: "terminal",
        command: "cat README.md",
        host: "Mac mini",
        deterministic: explainApproval("terminal", "cat README.md", "Mac mini"),
      };
      await reviewer(input, new AbortController().signal);
      writeAuth(home, "new-access-token");
      await reviewer(input, new AbortController().signal);
      expect(headers).toEqual(["Bearer old-access-token", "Bearer new-access-token"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sends the first-party OAuth request without any tool, file, cwd, or persistence surface", async () => {
    const seen: { url?: string; headers?: Headers; body?: string } = {};
    const reviewer = createCodexOAuthReviewer({
      model: "gpt-5.6-sol",
      accessToken: "oauth-secret",
      accountId: "account-123",
      fetchImpl: async (url, init) => {
        seen.url = String(url);
        seen.headers = new Headers(init?.headers);
        seen.body = String(init?.body);
        const text = JSON.stringify({
          purpose: "Reads the requested file",
          change: "Nothing; read-only",
          where: "README.md on Mac mini",
          risk: "low",
        });
        return new Response(codexSseBody(text), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const value = await reviewer({
      tool: "terminal",
      command: "cat README.md",
      host: "Mac mini",
      deterministic: explainApproval("terminal", "cat README.md", "Mac mini"),
    }, new AbortController().signal);
    expect(value).toMatchObject({ purpose: "Reads the requested file" });
    expect(seen.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(seen.headers?.get("chatgpt-account-id")).toBe("account-123");
    expect(seen.headers?.get("authorization")).toBe("Bearer oauth-secret");
    const payload = JSON.parse(seen.body ?? "{}");
    assertCodexNoToolsPayload(payload);
    expect(payload.tools).toBeUndefined();
    expect(payload.functions).toBeUndefined();
    expect(payload.input?.[0]?.content?.[0]?.type).toBe("input_text");
    expect(payload.store).toBe(false);
    expect(payload.stream).toBe(true);
    expect(seen.body).not.toContain("oauth-secret");
  });

  it("rejects malformed output and endpoints outside the fixed OpenAI origin", async () => {
    const reviewer = createCodexOAuthReviewer({
      model: "gpt-5.6-sol",
      accessToken: "oauth-secret",
      accountId: "account-123",
      endpoint: "https://evil.example/backend-api/codex/responses",
      fetchImpl: vi.fn(),
    });
    await expect(reviewer({
      tool: "terminal",
      command: "pwd",
      host: "Mac mini",
      deterministic: explainApproval("terminal", "pwd", "Mac mini"),
    }, new AbortController().signal)).rejects.toThrow(/endpoint|allowed/i);
    const malformed = createCodexOAuthReviewer({
      model: "gpt-5.6-sol",
      accessToken: "oauth-secret",
      accountId: "account-123",
      fetchImpl: async () => new Response(codexSseBody("not json"), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    await expect(malformed({
      tool: "terminal",
      command: "pwd",
      host: "Mac mini",
      deterministic: explainApproval("terminal", "pwd", "Mac mini"),
    }, new AbortController().signal)).rejects.toThrow(/strict JSON/i);
  });

  it("accepts the first-party event sequence and rejects tool or conflicting output", () => {
    const text = JSON.stringify({ purpose: "Read", change: "None", where: "README", risk: "low" });
    expect(JSON.parse(parseCodexSseFinalText(codexSseBody(text)))).toEqual(JSON.parse(text));
    expect(() => parseCodexSseFinalText(codexSseBody(text, { itemType: "function_call" }))).toThrow(/non-message|text/i);
    expect(() => parseCodexSseFinalText(codexSseBody(text, { finalText: `${text} ` }))).toThrow(/disagrees|strict/i);
    expect(() => parseCodexSseFinalText(codexSseBody(text).replace("event: response.completed", "event: response.unknown"))).toThrow(/not allowed/i);
  });
});

describe("reviewer security boundaries", () => {
  it("accepts only safe reviewer URLs and rejects credential-bearing or cleartext origins", () => {
    expect(isAllowedReviewerUrl("https://api.example.test/v1")).toBe(true);
    expect(isAllowedReviewerUrl("http://127.0.0.1:4102/v1")).toBe(true);
    expect(isAllowedReviewerUrl("http://localhost:4102/v1")).toBe(true);
    expect(isAllowedReviewerUrl("http://[::1]:4102/v1")).toBe(true);
    expect(isAllowedReviewerUrl("http://api.example.test/v1")).toBe(false);
    expect(isAllowedReviewerUrl("ftp://api.example.test/v1")).toBe(false);
    expect(isAllowedReviewerUrl("https://user:pass@api.example.test/v1")).toBe(false);
    expect(isAllowedReviewerUrl("https://api.example.test/v1?api_key=secret")).toBe(false);
    expect(() => reviewEndpoint("http://api.example.test/v1")).toThrow(/HTTPS|loopback/i);
    expect(reviewEndpoint("https://api.example.test/v1").toString()).toBe("https://api.example.test/v1/chat/completions");
  });

  it("refuses redirects and forwards a hard response-size cap", async () => {
    const oversized = new Response("123456789");
    await expect(readResponseTextCapped(oversized, 8)).rejects.toThrow(/byte limit/i);

    let requestInit: RequestInit | undefined;
    const reviewer = createDirectReviewer({
      url: "https://api.example.test/v1",
      apiKey: "sk-review-secret",
      model: "small-reviewer",
      maxResponseBytes: 32,
      fetchImpl: async (_url, init) => {
        requestInit = init;
        const response = new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    });
    await expect(reviewer({
      tool: "terminal",
      command: "cat README.md",
      host: "Mac mini",
      deterministic: explainApproval("terminal", "cat README.md", "Mac mini"),
    }, new AbortController().signal)).rejects.toThrow(/redirect/i);
    expect(requestInit?.redirect).toBe("error");
  });

  it("does not invoke invalid wrapper commands during help probing", async () => {
    const run = vi.fn((_cli, _args, _opts, cb) => cb(null, "help", ""));
    expect(validateReviewerCli("env claude")).toBeNull();
    expect(validateReviewerCli("npx claude")).toBeNull();
    expect(validateReviewerCli("/tmp/reviewer-wrapper")).toBeNull();
    expect(validateReviewerCli("claude")).toBe("claude");
    expect(await probeCliHelp("env claude", run)).toEqual({ installed: false, help: "" });
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps local facts authoritative and sanitizes the advisory note", async () => {
    const reviewer = vi.fn(async (input: ApprovalReviewInput) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.deterministic)).toBe(true);
      try {
        (input.deterministic as { riskLevel: string }).riskLevel = "low";
      } catch {
        // Frozen input is expected to reject mutation in strict mode.
      }
      return {
        purpose: "safe",
        change: "none",
        where: "README.md",
        risk: "low",
        advisory: "Looks safe; token=sk-ant-12345678901234567890 and https://127.0.0.1:4102/private",
      };
    });
    const reviewed = await reviewApproval(
      "terminal",
      "cat ~/.ssh/id_rsa",
      "Mac mini",
      reviewer,
      1_500,
      `security-${Date.now()}`,
    );
    expect(reviewed.source).toBe("ai-reviewed");
    expect(reviewed.riskLevel).toBe("high");
    expect(reviewed.executiveSummary).toMatch(/credential|private|sensitive/i);
    expect(reviewed.advisorySummary).not.toContain("sk-ant-12345678901234567890");
    expect(reviewed.advisorySummary).not.toContain("127.0.0.1:4102");
  });

  it("redacts route labels and never auto-selects an external provider", () => {
    const status = sanitizeApprovalReviewerStatus({
      mode: "when-unclear",
      selection: null,
      providers: [{
        id: "openrouter",
        label: "OpenRouter sk-proj-secret-1234567890123456",
        instanceId: "openaiCompat",
        available: true,
        configured: true,
        reason: "https://api.example.test/v1?token=secret",
        models: [{ id: "review", label: "Review\nmodel" }],
      }],
    });
    expect(JSON.stringify(status)).not.toContain("sk-proj-secret-1234567890123456");
    expect(JSON.stringify(status)).not.toContain("token=secret");
    expect(status.providers[0]?.models[0]?.label).toBe("Review model");
    expect(resolveStoredSelection({ mode: "when-unclear" }, status.providers)).toBeNull();
  });

  it("waits for child termination after requesting a kill", async () => {
    const listeners = new Map<string, () => void>();
    const child = {
      exitCode: null,
      signalCode: null,
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
        return this;
      },
    } as unknown as import("node:child_process").ChildProcess;
    let stopped = false;
    let settled = false;
    const done = waitForChildExit(child, () => { stopped = true; }).then(() => { settled = true; });
    expect(stopped).toBe(true);
    expect(settled).toBe(false);
    listeners.get("close")?.();
    await done;
    expect(settled).toBe(true);
  });
});

describe("isolated CLI runner", () => {
  it("extracts the final explanation from Codex JSONL events", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({ type: "item.completed", item: {
        type: "agent_message",
        text: JSON.stringify({ purpose: "Reads STAFF.md", change: "Nothing; read-only", where: "STAFF.md", risk: "low" }),
      } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(parseIsolatedCliOutput(output)).toMatchObject({ purpose: "Reads STAFF.md" });
  });

  it("runs from an empty cwd with a timeout and output cap, and parses structured output", async () => {
    const seen: Array<{ cwd?: string; args: string[]; maxBuffer?: number; timeout?: number }> = [];
    const reviewer = createCliReviewer({
      cli: "claude",
      family: "claude",
      model: "claude-haiku-4-5",
      run: (_cli, args, opts, cb) => {
        seen.push({ cwd: opts.cwd, args, maxBuffer: opts.maxBuffer, timeout: opts.timeout });
        cb(null, JSON.stringify({
          purpose: "Reads OPEN-GROK-ROUTING-RUNBOOK.md",
          change: "Nothing; read-only",
          where: "OPEN-GROK-ROUTING-RUNBOOK.md on Mac mini",
          risk: "low",
        }));
      },
    });
    const value = await reviewer({
      tool: "terminal",
      command: "sed -n '1,180p' OPEN-GROK-ROUTING-RUNBOOK.md",
      host: "Mac mini",
      deterministic: explainApproval("terminal", "sed -n '1,180p' OPEN-GROK-ROUTING-RUNBOOK.md", "Mac mini"),
    }, AbortSignal.timeout(1_500));
    expect(seen[0]?.cwd).toMatch(/omb-approval-review-/);
    expect(seen[0]?.args).toContain("--tools");
    expect(seen[0]?.maxBuffer).toBe(32_768);
    expect(value).toMatchObject({ where: expect.stringContaining("OPEN-GROK-ROUTING-RUNBOOK.md") });
  });
});

describe("review cache and fail-closed fallback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keys the cache by provider/model/input and does not recurse into tools", async () => {
    const calls: string[] = [];
    const make = (tag: string) => vi.fn(async (_input: unknown) => {
      calls.push(tag);
      return { purpose: tag, change: "Nothing; read-only", where: "README.md", risk: "low" };
    });
    const a = make("a");
    const b = make("b");
    const first = await reviewApproval("terminal", "cat README.md", "Mac mini", a, 1_500, reviewerCacheIdentity("openaiCompat", "llama"));
    const cached = await reviewApproval("terminal", "cat README.md", "Mac mini", a, 1_500, reviewerCacheIdentity("openaiCompat", "llama"));
    const otherModel = await reviewApproval("terminal", "cat README.md", "Mac mini", b, 1_500, reviewerCacheIdentity("openaiCompat", "other"));
    expect(first.executiveSummary).toBe("Reads README.md");
    expect(first.advisorySummary).toBe("a");
    expect(cached.executiveSummary).toBe("Reads README.md");
    expect(cached.advisorySummary).toBe("a");
    expect(otherModel.executiveSummary).toBe("Reads README.md");
    expect(otherModel.advisorySummary).toBe("b");
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(a.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it("falls back when the reviewer times out", async () => {
    const local = await reviewApproval("terminal", "cat README.md", "Mac mini", async (_input, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { purpose: "late", change: "x", where: "y", risk: "low" };
    }, 50, "timeout-lane");
    expect(local.source).toBe("local");
  });
});

describe("prompt and JSON extraction", () => {
  it("names files in the review prompt and extracts fenced JSON", () => {
    const prompt = buildApprovalReviewPrompt({
      tool: "terminal",
      command: "sed -n '1,180p' STAFF.md",
      host: "Mac mini",
      deterministic: explainApproval("terminal", "sed -n '1,180p' STAFF.md", "Mac mini"),
    });
    expect(prompt).toContain("STAFF.md");
    expect(extractReviewedJson("```json\n{\"purpose\":\"Reads STAFF.md\",\"change\":\"Nothing\",\"where\":\"STAFF.md\",\"risk\":\"low\"}\n```"))
      .toMatchObject({ purpose: "Reads STAFF.md" });
  });
});

describe("automatic approval reviewer policy", () => {
  const sampleProviders = [
    {
      id: "codex",
      label: "Codex",
      instanceId: "codex",
      available: true,
      configured: true,
      reason: null,
      models: [
        { id: "gpt-5.6-sol", label: "Sol" },
        { id: "gpt-5.6-luna", label: "Luna" },
      ],
    },
    {
      id: "claude",
      label: "Claude",
      instanceId: "claude",
      available: true,
      configured: true,
      reason: null,
      models: [
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      ],
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      instanceId: "openrouter",
      available: true,
      configured: true,
      reason: null,
      models: [
        { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "meta/llama-3-8b-instruct", label: "Llama 3 8B" },
      ],
    },
  ];

  it("preserves an explicit configured reviewer when valid and available", () => {
    const selection = {
      mode: "when-unclear" as const,
      instanceId: "claude",
      model: "claude-sonnet-5",
    };
    const effective = resolveEffectiveReviewerSelection(selection, sampleProviders);
    expect(effective).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
  });

  it("falls back automatically to preferred fast model when explicit reviewer is unavailable", () => {
    const selection = {
      mode: "when-unclear" as const,
      instanceId: "claude",
      model: "non-existent-model",
    };
    const effective = resolveEffectiveReviewerSelection(selection, sampleProviders);
    expect(effective).toEqual({ instanceId: "codex", model: "gpt-5.6-luna" });
  });

  it("prefers Luna, then Haiku, then Flash class models", () => {
    expect(autoSelectApprovalReviewer(sampleProviders)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
    });

    const withoutLuna = [
      {
        ...sampleProviders[0]!,
        models: [{ id: "gpt-5.6-sol", label: "Sol" }],
      },
      sampleProviders[1]!,
      sampleProviders[2]!,
    ];
    expect(autoSelectApprovalReviewer(withoutLuna)).toEqual({
      instanceId: "claude",
      model: "claude-haiku-4-5",
    });

    const withoutLunaOrHaiku = [
      {
        ...sampleProviders[0]!,
        models: [{ id: "gpt-5.6-sol", label: "Sol" }],
      },
      {
        ...sampleProviders[1]!,
        models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }],
      },
      sampleProviders[2]!,
    ];
    expect(autoSelectApprovalReviewer(withoutLunaOrHaiku)).toEqual({
      instanceId: "openrouter",
      model: "google/gemini-2.5-flash",
    });
  });

  it("falls back to other fast/mini models if Luna/Haiku/Flash are not in catalog", () => {
    const providers = [
      {
        id: "xai",
        label: "Grok",
        instanceId: "xai-api",
        available: true,
        configured: true,
        reason: null,
        models: [
          { id: "grok-4", label: "Grok 4" },
          { id: "grok-3-mini", label: "Grok 3 Mini" },
        ],
      },
    ];
    expect(autoSelectApprovalReviewer(providers)).toEqual({
      instanceId: "xai-api",
      model: "grok-3-mini",
    });
  });

  it("returns null when all catalogs are unavailable without crossing boundaries", () => {
    const unavailableProviders = sampleProviders.map((p) => ({
      ...p,
      available: false,
      reason: "Not configured",
    }));
    expect(autoSelectApprovalReviewer(unavailableProviders)).toBeNull();
    expect(resolveEffectiveReviewerSelection({ mode: "when-unclear" }, unavailableProviders)).toBeNull();
  });

  it("never persists an automatic choice unless config semantics require it", () => {
    const status = buildApprovalReviewerStatus(
      { approvalReviewer: { mode: "when-unclear" } },
      [{ instanceId: "codex", driverKind: "codex", models: { options: [{ id: "gpt-5.6-luna", label: "Luna" }] } }],
      {},
    );
    expect(status.selection).toBeNull();
    expect(status.mode).toBe("when-unclear");
  });

  it("bindApprovalReviewer binds auto-selected fast reviewer when selection is unconfigured", () => {
    const instances = [
      {
        instanceId: "openrouter",
        driverKind: "openai-compat",
        models: { options: [{ id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" }] },
      },
    ];
    const providers = [
      {
        id: "openrouter",
        label: "OpenRouter",
        instanceId: "openrouter",
        available: true,
        configured: true,
        reason: null,
        models: [{ id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" }],
      },
    ];
    const bound = bindApprovalReviewer({
      selection: { mode: "when-unclear" },
      providers,
      instances,
      credentials: { openaiCompat: { key: "sk-test", url: "https://openrouter.ai/api/v1" } },
    });
    expect(bound).not.toBeNull();
    expect(bound?.identity).toBe("openrouter:google/gemini-2.5-flash");
  });

  it("falls back deterministically on timeout and malformed output without altering risk", async () => {
    const timedOut = await reviewApproval(
      "terminal",
      "rm -rf /",
      "Mac mini",
      async (_input, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { purpose: "test", change: "test", where: "test", risk: "low" };
      },
      50,
      "test-timeout-identity",
    );
    expect(timedOut.source).toBe("local");
    expect(timedOut.riskLevel).toBe("high");

    const malformed = await reviewApproval(
      "terminal",
      "rm -rf /",
      "Mac mini",
      async () => "not a valid json object",
      500,
      "test-malformed-identity",
    );
    expect(malformed.source).toBe("local");
    expect(malformed.riskLevel).toBe("high");

    const validAdvisory = await reviewApproval(
      "terminal",
      "rm -rf /",
      "Mac mini",
      async () => ({
        purpose: "Clean up system files",
        change: "Deletes root directory",
        where: "/ on Mac mini",
        risk: "low",
        advisory: "This will delete your entire system",
      }),
      500,
      "test-advisory-identity",
    );
    expect(validAdvisory.source).toBe("ai-reviewed");
    expect(validAdvisory.riskLevel).toBe("high");
    expect(validAdvisory.advisorySummary).toBe("This will delete your entire system");
  });
});
