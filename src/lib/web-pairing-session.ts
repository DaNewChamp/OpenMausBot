import {
  canonicalHubOrigin,
  isWebPairingChallengeHash,
  serializeWebPairingLink,
  WEB_PAIRING_TTL_MS,
} from "../../shared/web-pairing-link";
import {
  HubPairError,
  persistHubConnection,
  normalizeHubBaseUrl,
  type WebHubConnection,
  type WebHubDevice,
} from "./web-client-session";

export const WEB_PAIRING_POLL_MS = 1_500;
export const WEB_PAIRING_MAX_POLLS = 80;

export interface WebPairingSecrets {
  requestId: string;
  redeemSecret: string;
  challengeHash: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomUrlSafe(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const source = globalThis.crypto;
  if (source?.getRandomValues) source.getRandomValues(bytes);
  else for (let i = 0; i < byteCount; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", encoded);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

export async function createWebPairingSecrets(): Promise<WebPairingSecrets> {
  const requestId = randomUrlSafe(16);
  const redeemSecret = randomUrlSafe(32);
  const challengeHash = await sha256Hex(redeemSecret);
  if (!isWebPairingChallengeHash(challengeHash)) {
    throw new HubPairError("Could not prepare a pairing request.");
  }
  return { requestId, redeemSecret, challengeHash };
}

function hubDevice(value: unknown): WebHubDevice | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  const stamp = (input: unknown) =>
    typeof input === "number" || typeof input === "string" ? input : null;
  return {
    id: record.id,
    name: record.name,
    createdAt: stamp(record.createdAt),
    lastSeenAt: stamp(record.lastSeenAt),
    cloudDesktopAccess: record.cloudDesktopAccess === true,
    localVmAccess: record.localVmAccess === true,
  };
}

export async function registerWebPairingRequest(input: {
  baseUrl: string;
  requestId: string;
  challengeHash: string;
  deviceName: string;
}): Promise<{ expiresAt: number; hubId: string; hubOrigin: string }> {
  const baseUrl = normalizeHubBaseUrl(input.baseUrl);
  if (!baseUrl) throw new HubPairError("Enter a valid hub address.");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/web-pairing/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: input.requestId,
        challengeHash: input.challengeHash,
        deviceName: input.deviceName,
      }),
    });
  } catch {
    throw new HubPairError("Could not reach that hub. Check the address and your connection.");
  }
  const payload = (await response.json().catch(() => ({}))) as {
    status?: unknown;
    expiresAt?: unknown;
    hubId?: unknown;
    hubOrigin?: unknown;
    error?: unknown;
  };
  if (!response.ok || payload.status !== "pending" || typeof payload.expiresAt !== "number") {
    const hubMessage = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
    throw new HubPairError(hubMessage ?? "Pairing could not finish.", { fromHub: Boolean(hubMessage) });
  }
  const hubOrigin = typeof payload.hubOrigin === "string" ? canonicalHubOrigin(payload.hubOrigin) : null;
  if (!hubOrigin || typeof payload.hubId !== "string") {
    throw new HubPairError("Pairing could not finish.");
  }
  return { expiresAt: payload.expiresAt, hubId: payload.hubId, hubOrigin };
}

export async function redeemWebPairingRequest(input: {
  baseUrl: string;
  requestId: string;
  redeemSecret: string;
  pairRequestId: string;
  deviceName: string;
}): Promise<"pending" | WebHubConnection> {
  const baseUrl = normalizeHubBaseUrl(input.baseUrl);
  if (!baseUrl) throw new HubPairError("Enter a valid hub address.");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/web-pairing/requests/${encodeURIComponent(input.requestId)}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redeemSecret: input.redeemSecret,
        pairRequestId: input.pairRequestId,
      }),
    });
  } catch {
    throw new HubPairError("Could not reach that hub. Check the address and your connection.");
  }
  if (response.status === 202) return "pending";
  const payload = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    error?: unknown;
    device?: unknown;
  };
  if (!response.ok || typeof payload.token !== "string") {
    const hubMessage = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
    throw new HubPairError(hubMessage ?? "Pairing could not finish.", { fromHub: Boolean(hubMessage) });
  }
  const device = hubDevice(payload.device);
  const connection: WebHubConnection = {
    baseUrl,
    deviceToken: payload.token,
    deviceName: device?.name ?? input.deviceName,
    device,
  };
  persistHubConnection(connection);
  return connection;
}

export async function cancelWebPairingRequest(input: {
  baseUrl: string;
  requestId: string;
  redeemSecret: string;
}): Promise<void> {
  const baseUrl = normalizeHubBaseUrl(input.baseUrl);
  if (!baseUrl) return;
  try {
    await fetch(`${baseUrl}/api/web-pairing/requests/${encodeURIComponent(input.requestId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redeemSecret: input.redeemSecret }),
    });
  } catch {
    /* unmount/cancel is best-effort */
  }
}

export type WebPairingPollResult = "pending" | "paired" | "expired" | "error";

export class WebPairingQrSession {
  secrets: WebPairingSecrets | null = null;
  link: string | null = null;
  expiresAt: number | null = null;
  pairRequestId: string | null = null;
  polls = 0;
  private baseUrl = "";
  private deviceName = "Web browser";

  async start(input: { baseUrl: string; deviceName: string }): Promise<void> {
    this.baseUrl = input.baseUrl;
    this.deviceName = input.deviceName;
    this.secrets = await createWebPairingSecrets();
    this.pairRequestId = this.secrets.requestId;
    this.polls = 0;
    const registered = await registerWebPairingRequest({
      baseUrl: input.baseUrl,
      requestId: this.secrets.requestId,
      challengeHash: this.secrets.challengeHash,
      deviceName: input.deviceName,
    });
    this.expiresAt = registered.expiresAt;
    this.link = serializeWebPairingLink({
      version: 1,
      hubOrigin: registered.hubOrigin,
      hubId: registered.hubId,
      requestId: this.secrets.requestId,
      challengeHash: this.secrets.challengeHash,
      deviceName: input.deviceName,
      expiresAt: registered.expiresAt,
    });
  }

  async pollOnce(): Promise<WebPairingPollResult> {
    if (!this.secrets || this.expiresAt === null || this.expiresAt <= Date.now() || this.polls >= WEB_PAIRING_MAX_POLLS) {
      this.clearSecrets();
      return "expired";
    }
    this.polls += 1;
    const result = await redeemWebPairingRequest({
      baseUrl: this.baseUrl,
      requestId: this.secrets.requestId,
      redeemSecret: this.secrets.redeemSecret,
      pairRequestId: this.pairRequestId ?? this.secrets.requestId,
      deviceName: this.deviceName,
    });
    if (result === "pending") return "pending";
    this.clearSecrets();
    return "paired";
  }

  async refresh(input: { baseUrl: string; deviceName: string }): Promise<void> {
    await this.cancelCurrent();
    await this.start(input);
  }

  async dispose(): Promise<void> {
    await this.cancelCurrent();
    this.clearSecrets();
    this.link = null;
    this.expiresAt = null;
  }

  private async cancelCurrent(): Promise<void> {
    if (!this.secrets) return;
    await cancelWebPairingRequest({
      baseUrl: this.baseUrl,
      requestId: this.secrets.requestId,
      redeemSecret: this.secrets.redeemSecret,
    });
  }

  private clearSecrets(): void {
    this.secrets = null;
    this.pairRequestId = null;
  }
}

export { WEB_PAIRING_TTL_MS };
