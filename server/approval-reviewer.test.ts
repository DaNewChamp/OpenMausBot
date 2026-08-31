import { afterEach, describe, expect, it, vi } from "vitest";

import { explainApproval, reviewApproval } from "./approval-explainer.ts";
import {
  approvalReviewerSelection,
  buildApprovalReviewerCatalog,
  buildApprovalReviewerStatus,
  buildApprovalReviewPrompt,
  catalogContainsSecrets,
  detectCliReviewCapability,
  codexHelpSupportsIsolatedReview,
  extractReviewedJson,
  parseApprovalReviewerPatch,
  reviewDriverFamily,
  reviewerCacheIdentity,
  shouldReviewApproval,
  validateReviewerSelection,
  XAI_REVIEW_INSTANCE_ID,
} from "./approval-reviewer.ts";
import { chatCompletionReviewPayload, createDirectReviewer } from "./approval-reviewer-direct.ts";
import {
  assertIsolatedReviewArgs,
  claudeIsolatedReviewArgs,
  codexIsolatedReviewArgs,
  createCliReviewer,
  cursorIsolatedReviewArgs,
  isolatedReviewEnv,
  parseIsolatedCliOutput,
} from "./approval-reviewer-cli.ts";

const CLAUDE_HELP = `
  -p, --print  Print response and exit
  --tools <tools...>  Use "" to disable all tools, "default" to use all tools
  --strict-mcp-config  Only use MCP servers from --mcp-config
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

describe("approval reviewer selection", () => {
  it("defaults to when-unclear and stores only nonsecret selection", () => {
    expect(approvalReviewerSelection({})).toEqual({ mode: "when-unclear" });
    expect(approvalReviewerSelection({ approvalReviewer: { mode: "always", instanceId: "openaiCompat", model: "llama" } })).toEqual({
      mode: "always",
      instanceId: "openaiCompat",
      model: "llama",
    });
  });

  it("selects the first available model when no reviewer is saved", () => {
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
    ).selection).toEqual({ instanceId: "codex", model: "gpt-5.6-sol" });
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
    expect(byId.cursor).toMatchObject({ available: true, configured: true });
    expect(byId.codex).toMatchObject({ available: true, configured: true, reason: null });
    expect(byId.grok?.available).toBe(false);
    expect(byId.grok?.reason).toMatch(/MCP/i);
    expect(catalogContainsSecrets(buildApprovalReviewerStatus(
      { approvalReviewer: { mode: "when-unclear", instanceId: "openaiCompat", model: "llama" } },
      [{ instanceId: "openaiCompat", driverKind: "openai-compat", models: { options: [{ id: "llama", label: "Llama" }] } }],
      { openaiCompat: { key: "sk-secret", url: "https://example.invalid/v1" } },
    ))).toBe(false);
  });

  it("accepts the Codex OAuth lane when its isolated mode is available", () => {
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
    expect(validateReviewerSelection({ mode: "always", instanceId: "codex", model: "gpt-5.4" }, providers).ok).toBe(true);
  });
});

describe("CLI isolation detection", () => {
  it("accepts Claude empty-tools print, Cursor ask, and Codex read-only exec, and refuses Grok Auth", () => {
    expect(detectCliReviewCapability("claude", CLAUDE_HELP).kind).toBe("supported");
    expect(detectCliReviewCapability("cursor", CURSOR_HELP).kind).toBe("supported");
    expect(codexHelpSupportsIsolatedReview(CODEX_HELP)).toBe(true);
    expect(detectCliReviewCapability("codex", CODEX_HELP).kind).toBe("supported");
    expect(detectCliReviewCapability("grok-auth", GROK_HELP).kind).toBe("unavailable");
    expect(reviewDriverFamily("claudeAgent", "claude")).toBe("claude");
    expect(reviewDriverFamily("cursorAgent", "cursor")).toBe("cursor");
    expect(reviewDriverFamily("codex", "codex")).toBe("codex");
    expect(reviewDriverFamily("grokAgent", "grok")).toBe("grok-auth");
    expect(reviewDriverFamily("grok", XAI_REVIEW_INSTANCE_ID)).toBe("xai");
  });

  it("builds isolated argv without MCP, force, or the app approval bus", () => {
    const prompt = "review this";
    const claude = claudeIsolatedReviewArgs(prompt, "claude-haiku-4-5");
    const cursor = cursorIsolatedReviewArgs(prompt, "auto");
    const codex = codexIsolatedReviewArgs(prompt, "gpt-5.6-sol");
    assertIsolatedReviewArgs("claude", claude);
    assertIsolatedReviewArgs("cursor", cursor);
    expect(claude).toContain("--tools");
    expect(claude[claude.indexOf("--tools") + 1]).toBe("");
    expect(claude).toContain("--strict-mcp-config");
    expect(claude).not.toContain("--mcp-config");
    expect(cursor.slice(0, 6)).toEqual(["--print", "--mode", "ask", "--sandbox", "enabled", "--output-format"]);
    expect(cursor).not.toContain("--force");
    expect(cursor).not.toContain("--approve-mcps");
    assertIsolatedReviewArgs("codex", codex);
    expect(codex).toContain("exec");
    expect(codex).toContain("--ephemeral");
    expect(codex[codex.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(codex).toContain("--ignore-user-config");
    const env = isolatedReviewEnv("claude", {
      ANTHROPIC_API_KEY: "sk-ant",
      XAI_API_KEY: "xai",
      CURSOR_API_KEY: "cursor",
      CURSOR_AUTH_TOKEN: "cursor-auth",
      HOME: "/tmp/home",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
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
    expect(first.executiveSummary).toBe("a");
    expect(cached.executiveSummary).toBe("a");
    expect(otherModel.executiveSummary).toBe("b");
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
