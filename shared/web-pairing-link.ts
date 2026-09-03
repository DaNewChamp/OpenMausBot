/** Versioned browser-approval QR payload. Distinct from `openmausbot://pair`. */

export const WEB_PAIRING_LINK_VERSION = 1;
export const WEB_PAIRING_LINK_SCHEME = "openmausbot:";
export const WEB_PAIRING_LINK_HOST = "web-pair";
export const WEB_PAIRING_TTL_MS = 120_000;

/** URL-safe request id: 22 unpadded base64url chars is 128 bits. */
export const WEB_PAIRING_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
export const WEB_PAIRING_CHALLENGE_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const WEB_PAIRING_HUB_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

const FORBIDDEN_QUERY_KEYS = new Set([
  "token",
  "code",
  "credential",
  "secret",
  "redeemsecret",
  "redeem",
  "pair",
]);

export interface WebPairingLinkPayload {
  version: typeof WEB_PAIRING_LINK_VERSION;
  hubOrigin: string;
  hubId: string;
  requestId: string;
  challengeHash: string;
  deviceName: string;
  expiresAt: number;
}

export function sanitizeWebPairingDeviceName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return name || "Web browser";
}

export function canonicalHubOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isWebPairingRequestId(value: string): boolean {
  return WEB_PAIRING_REQUEST_ID_PATTERN.test(value);
}

export function isWebPairingChallengeHash(value: string): boolean {
  return WEB_PAIRING_CHALLENGE_HASH_PATTERN.test(value);
}

function validPayload(input: WebPairingLinkPayload): WebPairingLinkPayload | null {
  if (input.version !== WEB_PAIRING_LINK_VERSION) return null;
  const hubOrigin = canonicalHubOrigin(input.hubOrigin);
  if (!hubOrigin) return null;
  if (!WEB_PAIRING_HUB_ID_PATTERN.test(input.hubId)) return null;
  if (!isWebPairingRequestId(input.requestId)) return null;
  if (!isWebPairingChallengeHash(input.challengeHash)) return null;
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) return null;
  return {
    version: WEB_PAIRING_LINK_VERSION,
    hubOrigin,
    hubId: input.hubId,
    requestId: input.requestId,
    challengeHash: input.challengeHash,
    deviceName: sanitizeWebPairingDeviceName(input.deviceName),
    expiresAt: input.expiresAt,
  };
}

/** Public QR deep link. Never includes redeemSecret, pairing codes, or tokens. */
export function serializeWebPairingLink(input: WebPairingLinkPayload): string | null {
  const payload = validPayload(input);
  if (!payload) return null;
  const url = new URL(`${WEB_PAIRING_LINK_SCHEME}//${WEB_PAIRING_LINK_HOST}`);
  url.searchParams.set("v", String(payload.version));
  url.searchParams.set("hub", payload.hubOrigin);
  url.searchParams.set("hid", payload.hubId);
  url.searchParams.set("rid", payload.requestId);
  url.searchParams.set("ch", payload.challengeHash);
  url.searchParams.set("n", payload.deviceName);
  url.searchParams.set("exp", String(payload.expiresAt));
  return url.toString();
}

export function parseWebPairingLink(text: string): WebPairingLinkPayload | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== WEB_PAIRING_LINK_SCHEME) return null;
  if (url.hostname.toLowerCase() !== WEB_PAIRING_LINK_HOST && url.host.toLowerCase() !== WEB_PAIRING_LINK_HOST) {
    return null;
  }

  const values = new Map<string, string>();
  for (const [rawName, value] of url.searchParams.entries()) {
    const name = rawName.toLowerCase();
    if (FORBIDDEN_QUERY_KEYS.has(name)) return null;
    if (values.has(rawName)) return null;
    values.set(rawName, value);
  }

  const version = Number(values.get("v"));
  const expiresAt = Number(values.get("exp"));
  if (!Number.isSafeInteger(expiresAt)) return null;
  return validPayload({
    version: version as typeof WEB_PAIRING_LINK_VERSION,
    hubOrigin: values.get("hub") ?? "",
    hubId: values.get("hid") ?? "",
    requestId: values.get("rid") ?? "",
    challengeHash: values.get("ch") ?? "",
    deviceName: values.get("n") ?? "",
    expiresAt,
  });
}

const SECRET_KEY_PATTERN = /^(redeemsecret|challengehash|token|credential|authorization|secret|code|ch|rid)$/i;

/** Drop pairing secrets so a log line cannot carry them. */
export function redactWebPairingSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactWebPairingSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) || /redeemsecret|challengehash|devicetoken|bearertoken/i.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactWebPairingSecrets(entry);
  }
  return out;
}
