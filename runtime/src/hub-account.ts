import type { HostSecretSnapshot, HostSecretStore } from "../../server/host-secret-store.ts";
import { HostSecretStoreUnavailableError } from "../../server/host-secret-store.ts";
import {
  ControlPlaneError,
  createControlPlaneClient,
  isValidOpaqueId,
  normalizeAccountEmail,
} from "../../shared/control-plane-client.mjs";
import { normalizeWirePlatform } from "../../shared/runtime-platform.ts";

export const ACCOUNT_TOKEN = "controlPlane.accountToken";
export const ACCOUNT_EMAIL = "controlPlane.accountEmail";
export const INSTALLATION_ID = "controlPlane.installationId";
export const INSTALLATION_CREDENTIAL = "controlPlane.installationCredential";
export const INSTALLATION_EXPIRY = "controlPlane.installationCredentialExpiresAt";

const INSTALLATION_CREDENTIAL_PATTERN = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const INSTALLATION_CREDENTIAL_PREFIX = "omb_install_";
const PRESENCE_CAPABILITIES = Object.freeze(["companion", "harness"]);

export interface HubAccountState {
  accountEmail?: string;
  installationId?: string;
  credentialExpiresAt?: number;
}

export interface FleetInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: "darwin" | "windows" | "linux";
  runtimeProfile: string;
  appVersion: string | null;
  capabilities: string[];
  lastSeenAt: number | null;
  online: boolean;
  endpoint: { url: string; status: string } | null;
}

type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;

type StoredValues = Record<string, string>;

interface HubAccountDependencies {
  client: ControlPlaneClient;
  identity: { schemaVersion: 1; id: string; createdAt: number };
  profile: "headless-hub";
  platform: "darwin" | "windows" | "linux";
  appVersion: string;
  displayName: string;
  secrets: HostSecretStore;
  now?: () => number;
}

function unavailable(message = "host secret store unavailable"): HostSecretStoreUnavailableError {
  return new HostSecretStoreUnavailableError(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readValues(secrets: HostSecretStore): StoredValues {
  let snapshot: HostSecretSnapshot;
  try {
    snapshot = secrets.read();
  } catch {
    throw unavailable();
  }
  if (!snapshot || snapshot.status === "unavailable") {
    throw unavailable();
  }
  if (snapshot.status !== "empty" && snapshot.status !== "ok") {
    throw unavailable();
  }
  if (!isPlainRecord(snapshot.values)) throw unavailable();
  const values: StoredValues = {};
  try {
    for (const [key, value] of Object.entries(snapshot.values)) {
      if (typeof key !== "string" || typeof value !== "string") throw unavailable();
      values[key] = value;
    }
  } catch (error) {
    if (error instanceof HostSecretStoreUnavailableError) throw error;
    throw unavailable();
  }
  return values;
}

function writeValue(secrets: HostSecretStore, name: string, value: string): void {
  // The store is a trust boundary. Do not issue a mutation based on a stale
  // or unavailable snapshot, even when a custom test store does not perform
  // the same check itself.
  readValues(secrets);
  try {
    secrets.set(name, value);
  } catch (error) {
    if (error instanceof HostSecretStoreUnavailableError) throw error;
    throw unavailable();
  }
}

function deleteValue(secrets: HostSecretStore, name: string): void {
  readValues(secrets);
  try {
    secrets.delete(name);
  } catch (error) {
    if (error instanceof HostSecretStoreUnavailableError) throw error;
    throw unavailable();
  }
}

function accountToken(value: unknown): string {
  return typeof value === "string" && value.length >= 20 && !value.startsWith(INSTALLATION_CREDENTIAL_PREFIX)
    ? value
    : "";
}

function installationCredential(value: unknown): string {
  return typeof value === "string" && INSTALLATION_CREDENTIAL_PATTERN.test(value) ? value : "";
}

function installationId(value: unknown): string {
  return typeof value === "string" && isValidOpaqueId(value) ? value : "";
}

function expiration(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= 0) return number;
  }
  return undefined;
}

function publicState(values: StoredValues): HubAccountState {
  const state: HubAccountState = {};
  const email = normalizeAccountEmail(values[ACCOUNT_EMAIL]);
  if (email) state.accountEmail = email;
  const id = installationId(values[INSTALLATION_ID]);
  if (id) state.installationId = id;
  const expiresAt = expiration(values[INSTALLATION_EXPIRY]);
  if (expiresAt !== undefined) state.credentialExpiresAt = expiresAt;
  return state;
}

function publicFleet(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicFleet);
  if (!isPlainRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|credential|secret|password|key)$/i.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = publicFleet(item);
    }
  }
  return result;
}

function safeError(error: unknown): unknown {
  if (error instanceof ControlPlaneError) return error;
  if (error instanceof HostSecretStoreUnavailableError) return error;
  if (error instanceof Error && error.message.length > 0 && error.message.length <= 280
    && !/(?:omb_install_|bearer|token|credential|secret|password|key)/i.test(error.message)) {
    return new Error(error.message);
  }
  return new Error("control plane request failed");
}

/**
 * Account and installation orchestration for a headless hub. The service
 * intentionally has no pairing/discovery side channel: account bearers are
 * used only for account routes, while the installation credential is used
 * only for presence.
 */
export function createHubAccountService({
  client,
  identity,
  profile,
  platform,
  appVersion,
  displayName,
  secrets,
  now = Date.now,
}: HubAccountDependencies) {
  if (profile !== "headless-hub") throw new Error("invalid runtime profile");
  if (!identity || identity.schemaVersion !== 1 || !isValidOpaqueId(identity.id)) {
    throw new ControlPlaneError("invalid_client_identity");
  }
  const wirePlatform = normalizeWirePlatform(platform);
  if (typeof appVersion !== "string" || appVersion.length > 64) throw new Error("invalid app version");
  if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > 80) {
    throw new Error("invalid hub name");
  }

  let stopped = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const inFlightPresence = new Set<Promise<void>>();

  const state = (): HubAccountState => publicState(readValues(secrets));

  const requestCode = async (rawEmail: string): Promise<{ email: string }> => {
    const email = normalizeAccountEmail(rawEmail);
    if (!email) throw new ControlPlaneError("invalid_email");
    let result;
    try {
      result = await client.requestOTP(email);
    } catch (error) {
      throw safeError(error);
    }
    const requested = normalizeAccountEmail(result?.email);
    if (!requested) throw new ControlPlaneError("invalid_response");
    return { email: requested };
  };

  const verifyCode = async (rawEmail: string, otp: string): Promise<HubAccountState> => {
    const email = normalizeAccountEmail(rawEmail);
    if (!email) throw new ControlPlaneError("invalid_email");
    // Verification persists the account bearer below, so fail closed on an
    // unavailable store before sending the OTP to the control plane.
    readValues(secrets);
    let verified;
    try {
      verified = await client.verifyOTP(email, otp);
    } catch (error) {
      throw safeError(error);
    }
    const token = accountToken(verified?.accountToken);
    const verifiedEmail = normalizeAccountEmail(verified?.user?.email);
    if (!token || !verifiedEmail || verifiedEmail !== email) {
      throw new ControlPlaneError("invalid_response");
    }
    writeValue(secrets, ACCOUNT_EMAIL, verifiedEmail);
    writeValue(secrets, ACCOUNT_TOKEN, token);
    return state();
  };

  const register = async (): Promise<HubAccountState> => {
    const values = readValues(secrets);
    const token = accountToken(values[ACCOUNT_TOKEN]);
    if (!token) throw new ControlPlaneError("signed_out", 401);
    const currentCredential = installationCredential(values[INSTALLATION_CREDENTIAL]);
    let result;
    try {
      result = await client.ensureInstallation({
        accountToken: token,
        currentCredential,
        clientInstanceId: identity.id,
        name: displayName,
        platform: wirePlatform,
        appVersion,
      });
    } catch (error) {
      throw safeError(error);
    }
    const installation = result?.installation;
    const id = installationId(installation?.id);
    const credential = installationCredential(result?.credential);
    const returnedClientInstanceId = installation?.clientInstanceId;
    if (
      !id ||
      !credential ||
      (returnedClientInstanceId !== undefined && returnedClientInstanceId !== identity.id)
    ) {
      throw new ControlPlaneError("invalid_response");
    }
    writeValue(secrets, INSTALLATION_ID, id);
    writeValue(secrets, INSTALLATION_CREDENTIAL, credential);
    const expiresAt = expiration(result?.credentialExpiresAt);
    if (expiresAt === undefined) {
      deleteValue(secrets, INSTALLATION_EXPIRY);
    } else {
      writeValue(secrets, INSTALLATION_EXPIRY, String(expiresAt));
    }
    return state();
  };

  const heartbeat = async (): Promise<void> => {
    if (stopped || disposed) return;
    const values = readValues(secrets);
    const credential = installationCredential(values[INSTALLATION_CREDENTIAL]);
    if (!credential) throw new ControlPlaneError("signed_out", 401);
    const work = Promise.resolve().then(() => client.updatePresence(credential, {
      runtimeProfile: profile,
      appVersion,
      capabilities: [...PRESENCE_CAPABILITIES].sort(),
    })).catch((error) => {
      throw safeError(error);
    });
    inFlightPresence.add(work);
    try {
      await work;
    } finally {
      inFlightPresence.delete(work);
    }
  };

  const fleet = async (): Promise<FleetInstallation[]> => {
    const values = readValues(secrets);
    const token = accountToken(values[ACCOUNT_TOKEN]);
    if (!token) throw new ControlPlaneError("signed_out", 401);
    let records;
    try {
      records = await client.listFleet(token);
    } catch (error) {
      throw safeError(error);
    }
    return publicFleet(records) as FleetInstallation[];
  };

  const stopPresence = (): void => {
    stopped = true;
  };

  const dispose = async (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    stopPresence();
    disposePromise = Promise.allSettled([...inFlightPresence]).then(() => undefined);
    await disposePromise;
  };

  const signOut = async (): Promise<void> => {
    stopPresence();
    const values = readValues(secrets);
    const token = accountToken(values[ACCOUNT_TOKEN]);
    if (token) {
      try {
        await client.signOut(token);
      } catch {
        // Removing the local bearer is authoritative for a headless sign-out;
        // a remote session can expire without deleting the installation.
      }
      deleteValue(secrets, ACCOUNT_TOKEN);
    }
  };

  // Keep `now` in the dependency contract for callers that build a common
  // runtime service fixture. It is intentionally not used for scheduling in
  // Wave 1, where heartbeats are explicit one-shot operations.
  void now;

  return Object.freeze({
    requestCode,
    verifyCode,
    register,
    heartbeat,
    fleet,
    stopPresence,
    dispose,
    signOut,
  });
}
