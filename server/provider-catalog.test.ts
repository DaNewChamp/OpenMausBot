import { describe, expect, it } from "vitest";

import {
  NAMED_PROVIDER_ORDER,
  catalogContainsSecretFields,
  classifyProvider,
  normalizeModelLabel,
  orderProviders,
  resolveCatalogSelection,
  sanitizeMobileProviderCatalog,
  type MobileCatalogProvider,
} from "./provider-catalog.ts";

const sample = (overrides: {
    instanceId?: string;
    driverKind?: string;
    displayName?: string;
    models?: Array<{ id: string; label: string }>;
    default?: string;
    cli?: string;
    cliDefault?: string;
    cliCandidates?: string[];
    install?: { signInCommand: string; command: { darwin: string } };
    apiKey?: string;
    api_key?: string;
    environment?: { OPENAI_API_KEY: string };
    config?: { key: string };
  } = {}) => ({
  instanceId: overrides.instanceId ?? "cursor",
  driverKind: overrides.driverKind ?? "cursorAgent",
  displayName: overrides.displayName ?? "Cursor",
  snapshot: { state: "available" },
  models: {
    default: overrides.default ?? overrides.models?.[0]?.id ?? "auto",
    options: overrides.models ?? [
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5" },
    ],
  },
  cli: overrides.cli,
  cliDefault: overrides.cliDefault,
  cliCandidates: overrides.cliCandidates,
  install: overrides.install,
  apiKey: overrides.apiKey,
  api_key: overrides.api_key,
  environment: overrides.environment,
  config: overrides.config,
});

describe("classifyProvider", () => {
  it("routes GPT/Codex to OpenAI, including GPT-5.6-Sol from Codex", () => {
    expect(classifyProvider({ instanceId: "codex", driverKind: "codex", modelId: "gpt-5.6-sol" })).toBe("openai");
    expect(classifyProvider({ instanceId: "codex", driverKind: "codex", modelId: "gpt-5.4-mini" })).toBe("openai");
    expect(classifyProvider({ instanceId: "cursor", driverKind: "cursorAgent", modelId: "gpt-5.3-codex" })).toBe(
      "openai",
    );
  });

  it("routes Claude models to Claude even when Cursor advertises them", () => {
    expect(classifyProvider({ instanceId: "claude", driverKind: "claudeAgent", modelId: "claude-sonnet-5" })).toBe(
      "claude",
    );
    expect(
      classifyProvider({
        instanceId: "cursor",
        driverKind: "cursorAgent",
        modelId: "claude-sonnet-5-thinking-high",
      }),
    ).toBe("claude");
  });

  it("routes Composer and Cursor Auto to Cursor", () => {
    expect(classifyProvider({ instanceId: "cursor", driverKind: "cursorAgent", modelId: "auto" })).toBe("cursor");
    expect(classifyProvider({ instanceId: "cursor", driverKind: "cursorAgent", modelId: "default[]" })).toBe("cursor");
    expect(classifyProvider({ instanceId: "cursor", driverKind: "cursorAgent", modelId: "composer-2.5" })).toBe(
      "cursor",
    );
  });

  it("routes OpenRouter and slash-shaped ids there, and Grok OAuth to Grok Auth", () => {
    expect(
      classifyProvider({
        instanceId: "openai-compat",
        driverKind: "openai-compat",
        modelId: "meta-llama/llama-3.3-70b-instruct",
      }),
    ).toBe("openrouter");
    expect(
      classifyProvider({
        instanceId: "openrouter",
        driverKind: "openrouter",
        modelId: "anthropic/claude-sonnet",
      }),
    ).toBe("openrouter");
    expect(classifyProvider({ instanceId: "grok", driverKind: "grokAgent", modelId: "grok-4.6" })).toBe("grok-auth");
    expect(classifyProvider({ instanceId: "cursor", driverKind: "cursorAgent", modelId: "grok-4.6" })).toBe("cursor");
  });
});

describe("normalizeModelLabel", () => {
  it("renames bare Auto to Cursor Auto", () => {
    expect(normalizeModelLabel("auto", "Auto", "cursor")).toBe("Cursor Auto");
    expect(normalizeModelLabel("auto", "", "cursor")).toBe("Cursor Auto");
    expect(normalizeModelLabel("default[]", "Auto", "cursor")).toBe("Cursor Auto");
  });
});

describe("sanitizeMobileProviderCatalog", () => {
  it("orders named providers exactly and places remaining after them", () => {
    const catalog = sanitizeMobileProviderCatalog([
      sample({
        instanceId: "gemini",
        driverKind: "geminiAgent",
        displayName: "Gemini",
        models: [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }],
      }),
      sample({
        instanceId: "grok",
        driverKind: "grokAgent",
        displayName: "Grok",
        models: [{ id: "grok-4.6", label: "Grok 4.6" }],
      }),
      sample({
        instanceId: "openai-compat",
        driverKind: "openai-compat",
        displayName: "OpenRouter",
        models: [{ id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" }],
      }),
      sample({
        instanceId: "cursor",
        driverKind: "cursorAgent",
        models: [
          { id: "auto", label: "Auto" },
          { id: "composer-2.5", label: "Composer 2.5" },
          { id: "gpt-5.3-codex", label: "Codex 5.3" },
          { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5" },
        ],
      }),
      sample({
        instanceId: "codex",
        driverKind: "codex",
        displayName: "Codex",
        models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      }),
      sample({
        instanceId: "other-a",
        driverKind: "minimax",
        displayName: "MiniMax",
        models: [{ id: "minimax-m3", label: "MiniMax M3" }],
      }),
      sample({
        instanceId: "claude",
        driverKind: "claudeAgent",
        displayName: "Claude",
        models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
      }),
    ]);

    expect(catalog.providers.map((provider) => provider.id)).toEqual([
      "openai",
      "claude",
      "cursor",
      "openrouter",
      "grok-auth",
      "google",
      "minimax",
    ]);
    expect(NAMED_PROVIDER_ORDER).toEqual(["openai", "claude", "cursor", "openrouter", "grok-auth"]);
    expect(catalog.providers.slice(0, 5).map((provider) => provider.label)).toEqual([
      "OpenAI",
      "Claude",
      "Cursor",
      "OpenRouter",
      "Grok Auth",
    ]);
    expect(catalog.providers.find((provider) => provider.id === "openai")?.models.map((model) => model.id)).toEqual([
      "gpt-5.3-codex",
      "gpt-5.6-sol",
    ]);
    expect(catalog.providers.find((provider) => provider.id === "claude")?.models.map((model) => model.id).sort()).toEqual(
      ["claude-haiku-4-5", "claude-sonnet-5-thinking-high"],
    );
    expect(catalog.providers.find((provider) => provider.id === "cursor")?.models.map((model) => model.id)).toEqual([
      "auto",
      "composer-2.5",
    ]);
    expect(catalog.providers.find((provider) => provider.id === "cursor")?.models[0]?.label).toBe("Cursor Auto");
    expect(catalog.providers.some((provider) => provider.label === "GPT-5.6 Sol")).toBe(false);
    expect(catalog.providers.some((provider) => provider.id === "codex")).toBe(false);
  });

  it("does not serialize secret fields onto the mobile catalog", () => {
    const catalog = sanitizeMobileProviderCatalog([
      sample({
        cli: "/usr/local/bin/cursor-agent",
        cliDefault: "cursor-agent",
        cliCandidates: ["/opt/cursor/cursor-agent"],
        install: { signInCommand: "cursor-agent login", command: { darwin: "curl | bash" } },
        apiKey: "sk-secret-should-not-leak",
        api_key: "also-secret",
        environment: { OPENAI_API_KEY: "sk-env" },
        config: { key: "sk-config" },
      }),
    ]);
    const serialized = JSON.stringify(catalog);
    expect(catalogContainsSecretFields(catalog)).toBe(false);
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("sk-env");
    expect(serialized).not.toContain("sk-config");
    expect(serialized).not.toContain("cliCandidates");
    expect(serialized).not.toContain("/usr/local/bin");
    expect(serialized).not.toContain("signInCommand");
    expect(serialized).toContain("Cursor Auto");
    expect(catalog.managedBy).toBe("Managed by your V Bot server.");
  });
});

describe("resolveCatalogSelection", () => {
  const catalog = sanitizeMobileProviderCatalog([
    sample({
      instanceId: "codex",
      driverKind: "codex",
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.4", label: "GPT-5.4" },
      ],
      default: "gpt-5.6-sol",
    }),
    sample({
      instanceId: "cursor",
      driverKind: "cursorAgent",
      models: [
        { id: "auto", label: "Auto" },
        { id: "composer-2.5", label: "Composer 2.5" },
      ],
    }),
  ]);

  it("keeps a still-advertised selection across refresh", () => {
    expect(resolveCatalogSelection({ instanceId: "cursor", model: "composer-2.5" }, catalog)).toEqual({
      instanceId: "cursor",
      model: "composer-2.5",
    });
  });

  it("falls back deterministically when the selected model disappears", () => {
    expect(resolveCatalogSelection({ instanceId: "codex", model: "retired-gpt" }, catalog)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("falls back to the first named provider when the instance is gone", () => {
    expect(resolveCatalogSelection({ instanceId: "gone", model: "gone-1" }, catalog)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });
});

describe("orderProviders", () => {
  it("keeps unknown providers after the named order, sorted by label then id", () => {
    const providers: MobileCatalogProvider[] = [
      { id: "zeta", label: "Zeta", markKey: "zeta", models: [] },
      { id: "cursor", label: "Cursor", markKey: "cursor", models: [] },
      { id: "alpha", label: "Alpha", markKey: "alpha", models: [] },
      { id: "openai", label: "OpenAI", markKey: "openai", models: [] },
    ];
    expect(orderProviders(providers).map((provider) => provider.id)).toEqual(["openai", "cursor", "alpha", "zeta"]);
  });
});
