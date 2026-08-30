// Server-driven mobile provider catalog.
//
// Desktop still consumes `GET /api/instances` as advertised engine rows
// (install commands, CLI paths). The phone is a thin client: it receives a
// sanitized, provider-grouped catalog with display metadata only. Selection
// stays `{ instanceId, model }` so PATCH /api/bots/:id/model is unchanged.

export const NAMED_PROVIDER_ORDER = ["openai", "claude", "cursor", "openrouter", "grok-auth"] as const;
export type NamedProviderId = (typeof NAMED_PROVIDER_ORDER)[number];

export const NAMED_PROVIDER_LABELS = {
  openai: "OpenAI",
  claude: "Claude",
  cursor: "Cursor",
  openrouter: "OpenRouter",
  "grok-auth": "Grok Auth",
} as const;

export const MANAGED_BY_SERVER = "Managed by your V Bot server.";

const SECRET_JSON_KEY =
  /"(?:api[_-]?key|cli|cliDefault|cliCandidates|install|environment|config|key|gatewayToken|token|secret|password)"/i;

export interface AdvertisedCatalogInstance {
  instanceId?: string;
  driverKind?: string;
  displayName?: string;
  snapshot?: {
    state?: string;
    reason?: string | null;
    authenticated?: boolean | null;
    version?: string | null;
  };
  models?: {
    default?: string;
    options?: Array<{ id?: string; label?: string }>;
  };
  capabilities?: { effortLevels?: readonly string[]; computerMcp?: boolean; localComputerMcp?: boolean };
}

export interface MobileCatalogModel {
  id: string;
  label: string;
  instanceId: string;
  isDefault: boolean;
}

export interface MobileCatalogProvider {
  id: string;
  label: string;
  markKey: string;
  models: MobileCatalogModel[];
}

export interface MobileProviderCatalog {
  managedBy: string;
  providers: MobileCatalogProvider[];
}

export interface CatalogSelection {
  instanceId: string;
  model: string;
}

function compact(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeKey(value: string): string {
  return compact(value)
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/agent$/i, "");
}

function driverToken(driverKind: string, instanceId: string): string {
  return `${normalizeKey(driverKind)} ${normalizeKey(instanceId)}`.replace(/\s+/g, " ").trim();
}

function modelBase(modelId: string): string {
  return normalizeKey(modelId).split("[")[0] ?? "";
}

export function isOpenAiModelId(modelId: string): boolean {
  const id = modelBase(modelId);
  if (!id) return false;
  if (id.startsWith("gpt-") || id.startsWith("chatgpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return true;
  }
  return /(^|[-_])codex($|[-_])/.test(id) || id.includes("codex");
}

export function isClaudeModelId(modelId: string): boolean {
  return modelBase(modelId).startsWith("claude");
}

export function isCursorAutoModelId(modelId: string): boolean {
  const id = modelBase(modelId);
  return id === "auto" || id === "default";
}

export function isComposerModelId(modelId: string): boolean {
  return modelBase(modelId).startsWith("composer");
}

function isGrokAuthDriver(driverKind: string, instanceId: string): boolean {
  const raw = `${driverKind} ${instanceId}`.toLowerCase().replace(/_/g, "-");
  return /grok-?agent/.test(raw);
}

function isOpenRouterDriver(driverKind: string, instanceId: string): boolean {
  const token = driverToken(driverKind, instanceId);
  return token.includes("openai-compat") || token.includes("openaicompat") || token.includes("openrouter");
}

function isOpenCodeDriver(driverKind: string, instanceId: string): boolean {
  const token = driverToken(driverKind, instanceId);
  return token.includes("opencode");
}

function isCursorDriver(driverKind: string, instanceId: string): boolean {
  const token = driverToken(driverKind, instanceId);
  return token.includes("cursor");
}

function isCodexDriver(driverKind: string, instanceId: string): boolean {
  const token = driverToken(driverKind, instanceId);
  return /\bcodex\b/.test(token);
}

function isClaudeDriver(driverKind: string, instanceId: string): boolean {
  const token = driverToken(driverKind, instanceId);
  return token.includes("claude");
}

export function remainingProviderId(driverKind: string, instanceId: string): string {
  const driver = normalizeKey(driverKind).replace(/-/g, "");
  if (driver.includes("gemini") || instanceId.toLowerCase().includes("gemini")) return "google";
  const fallback = normalizeKey(driverKind) || normalizeKey(instanceId) || "other";
  return fallback || "other";
}

export function remainingProviderLabel(id: string, displayName: string, driverKind: string): string {
  if (id === "google") return "Google";
  const name = compact(displayName);
  if (name) return name;
  const driver = compact(driverKind);
  if (driver) return driver;
  return id
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function classifyProvider(input: {
  instanceId: string;
  driverKind: string;
  modelId: string;
}): string {
  const instanceId = compact(input.instanceId);
  const driverKind = compact(input.driverKind);
  const modelId = compact(input.modelId);
  if (isGrokAuthDriver(driverKind, instanceId)) return "grok-auth";
  if (isOpenRouterDriver(driverKind, instanceId)) return "openrouter";
  if (modelId.includes("/") && !isOpenCodeDriver(driverKind, instanceId) && !isCursorDriver(driverKind, instanceId)) {
    return "openrouter";
  }
  if (isCursorAutoModelId(modelId) && isCursorDriver(driverKind, instanceId)) return "cursor";
  if (isComposerModelId(modelId)) return "cursor";
  if (isOpenAiModelId(modelId) || isCodexDriver(driverKind, instanceId)) return "openai";
  if (isClaudeModelId(modelId) || isClaudeDriver(driverKind, instanceId)) return "claude";
  if (isCursorDriver(driverKind, instanceId)) return "cursor";
  return remainingProviderId(driverKind, instanceId);
}

export function providerLabel(id: string, displayName = "", driverKind = ""): string {
  switch (id) {
    case "openai":
    case "claude":
    case "cursor":
    case "openrouter":
    case "grok-auth":
      return NAMED_PROVIDER_LABELS[id];
    default:
      return remainingProviderLabel(id, displayName, driverKind);
  }
}

export function providerMarkKey(id: string): string {
  if (id === "grok-auth") return "grok";
  if (id === "openai") return "openai";
  if (id === "google") return "gemini";
  return id;
}

export function normalizeModelLabel(modelId: string, label: string, providerId: string): string {
  const trimmed = compact(label);
  const id = modelBase(modelId);
  if (providerId === "cursor" && (id === "auto" || id === "default" || trimmed.toLowerCase() === "auto")) {
    return "Cursor Auto";
  }
  if (trimmed) return trimmed;
  if (id === "auto") return providerId === "cursor" ? "Cursor Auto" : "Auto";
  return modelId
    .split(/[-_./]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compareRemaining(a: MobileCatalogProvider, b: MobileCatalogProvider): number {
  const byLabel = a.label.localeCompare(b.label);
  if (byLabel !== 0) return byLabel;
  return a.id.localeCompare(b.id);
}

export function orderProviders(providers: readonly MobileCatalogProvider[]): MobileCatalogProvider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const ordered: MobileCatalogProvider[] = [];
  for (const id of NAMED_PROVIDER_ORDER) {
    const named = byId.get(id);
    if (named) {
      ordered.push(named);
      byId.delete(id);
    }
  }
  const remaining = [...byId.values()].sort(compareRemaining);
  return [...ordered, ...remaining];
}

export function catalogContainsSecretFields(catalog: MobileProviderCatalog): boolean {
  return SECRET_JSON_KEY.test(JSON.stringify(catalog));
}

export function sanitizeMobileProviderCatalog(
  instances: readonly AdvertisedCatalogInstance[],
): MobileProviderCatalog {
  const groups = new Map<string, MobileCatalogProvider>();
  for (const instance of instances) {
    const instanceId = compact(instance.instanceId);
    if (!instanceId) continue;
    const driverKind = compact(instance.driverKind) || instanceId;
    const displayName = compact(instance.displayName);
    const options = instance.models?.options ?? [];
    const defaultId = compact(instance.models?.default);
    for (const option of options) {
      const modelId = compact(option.id);
      if (!modelId) continue;
      const providerId = classifyProvider({ instanceId, driverKind, modelId });
      const existing = groups.get(providerId) ?? {
        id: providerId,
        label: providerLabel(providerId, displayName, driverKind),
        markKey: providerMarkKey(providerId),
        models: [],
      };
      if (!groups.has(providerId)) {
        groups.set(providerId, existing);
      }
      if (existing.models.some((model) => model.instanceId === instanceId && model.id === modelId)) continue;
      existing.models.push({
        id: modelId,
        label: normalizeModelLabel(modelId, compact(option.label), providerId),
        instanceId,
        isDefault: modelId === defaultId,
      });
    }
  }
  return {
    managedBy: MANAGED_BY_SERVER,
    providers: orderProviders([...groups.values()].filter((provider) => provider.models.length > 0)),
  };
}

export function selectionExists(selection: CatalogSelection, catalog: MobileProviderCatalog): boolean {
  return catalog.providers.some((provider) =>
    provider.models.some((model) => model.instanceId === selection.instanceId && model.id === selection.model),
  );
}

function firstModel(models: readonly MobileCatalogModel[]): MobileCatalogModel | undefined {
  return models.find((model) => model.isDefault) ?? models[0];
}

export function resolveCatalogSelection(
  selection: CatalogSelection,
  catalog: MobileProviderCatalog,
): CatalogSelection {
  if (selectionExists(selection, catalog)) return selection;
  const sameInstance = catalog.providers.flatMap((provider) =>
    provider.models.filter((model) => model.instanceId === selection.instanceId),
  );
  const instanceFallback = firstModel(sameInstance);
  if (instanceFallback) return { instanceId: instanceFallback.instanceId, model: instanceFallback.id };

  const provider = catalog.providers.find((candidate) =>
    candidate.models.some((model) => model.instanceId === selection.instanceId),
  );
  const providerFallback = provider ? firstModel(provider.models) : undefined;
  if (providerFallback) return { instanceId: providerFallback.instanceId, model: providerFallback.id };

  const firstProvider = catalog.providers[0];
  const catalogFallback = firstProvider ? firstModel(firstProvider.models) : undefined;
  if (catalogFallback) return { instanceId: catalogFallback.instanceId, model: catalogFallback.id };
  return selection;
}
