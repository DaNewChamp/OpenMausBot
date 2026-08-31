import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCOUNT_TOKEN as ACCOUNT_TOKEN_FIELD,
  createHubAccountService,
} from "./hub-account.ts";
import { createFileEnvelopeSecretStore, HostSecretStoreUnavailableError } from "../../server/host-secret-store.ts";
import { loadOrCreateHubIdentity } from "../../shared/hub-identity.mjs";

const ACCOUNT_TOKEN = `signed.${"a".repeat(40)}`;
const INSTALLATION_CREDENTIAL = `omb_install_${"b".repeat(22)}.${"c".repeat(43)}`;
const INSTALLATION_ID = "installation-opaque-id";
const EMAIL = "owner@example.com";
const USER = { id: "user-1", email: EMAIL };

const fleet = {
  id: INSTALLATION_ID,
  clientInstanceId: "hub-id",
  name: "Home Hub",
  platform: "linux",
  runtimeProfile: "headless-hub",
  appVersion: "0.1.37",
  capabilities: ["companion", "harness"],
  lastSeenAt: 1,
  online: true,
  endpoint: null,
};

const fixture = (overrides: Record<string, unknown> = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), "vbot-account-"));
  const identity = loadOrCreateHubIdentity({ dataDir, preferredId: "hub-id", now: () => 1 });
  const secrets = createFileEnvelopeSecretStore({ dataDir });
  const client = {
    requestOTP: vi.fn(async (email: string) => ({ email })),
    verifyOTP: vi.fn(async (email: string) => ({ accountToken: ACCOUNT_TOKEN, user: { ...USER, email } })),
    ensureInstallation: vi.fn(async () => ({
      installation: { ...fleet },
      credential: INSTALLATION_CREDENTIAL,
      credentialExpiresAt: 12345,
    })),
    updatePresence: vi.fn(async () => {}),
    listFleet: vi.fn(async () => [fleet]),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
  const service = createHubAccountService({
    client: client as never,
    identity,
    profile: "headless-hub",
    platform: "linux",
    appVersion: "0.1.37",
    displayName: "Home Hub",
    secrets,
    now: () => 1000,
  });
  return { dataDir, identity, secrets, client, service };
};

const cleanup = (dataDir: string) => rmSync(dataDir, { recursive: true, force: true });

describe("headless hub account service", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dataDir of directories.splice(0)) cleanup(dataDir);
  });

  it("normalizes request-code email and stores no credential", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await expect(f.service.requestCode(" Owner@Example.COM ")).resolves.toEqual({ email: EMAIL });
    expect(f.client.requestOTP).toHaveBeenCalledWith(EMAIL);
    expect(f.secrets.read()).toEqual({ status: "empty", values: {} });
  });

  it("stores only the account token and normalized email after verification", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await expect(f.service.verifyCode(" OWNER@EXAMPLE.COM ", "12-34-56-78")).resolves.toEqual({ accountEmail: EMAIL });
    expect(f.secrets.read()).toMatchObject({ status: "ok", values: { "controlPlane.accountToken": ACCOUNT_TOKEN, "controlPlane.accountEmail": EMAIL } });
  });

  it("registers with stable identity and keeps the public state credential-free", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await expect(f.service.register()).resolves.toEqual({ accountEmail: EMAIL, installationId: INSTALLATION_ID, credentialExpiresAt: 12345 });
    expect(f.client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({
      accountToken: ACCOUNT_TOKEN,
      currentCredential: "",
      clientInstanceId: "hub-id",
      name: "Home Hub",
      platform: "linux",
      appVersion: "0.1.37",
    }));
    expect(JSON.stringify(await f.service.register())).not.toContain(ACCOUNT_TOKEN);
    expect(JSON.stringify(await f.service.register())).not.toContain(INSTALLATION_CREDENTIAL);
  });

  it("reuses a valid stored installation credential and allows recovery after definitive self 401", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.secrets.set("controlPlane.installationCredential", INSTALLATION_CREDENTIAL);
    await f.secrets.set("controlPlane.installationId", INSTALLATION_ID);
    await f.secrets.set("controlPlane.installationAccountEmail", EMAIL);
    await f.secrets.set("controlPlane.installationAccountUserId", USER.id);
    await expect(f.service.register()).resolves.toMatchObject({ installationId: INSTALLATION_ID });
    expect(f.client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({ currentCredential: INSTALLATION_CREDENTIAL }));
  });

  it("does not rotate or replace stored credentials on unavailable registration", async () => {
    const f = fixture({ ensureInstallation: vi.fn(async () => { throw new Error("network unavailable"); }) }); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.secrets.set("controlPlane.installationCredential", INSTALLATION_CREDENTIAL);
    await expect(f.service.register()).rejects.toThrow("network unavailable");
    expect(f.secrets.read()).toMatchObject({ status: "ok", values: { "controlPlane.installationCredential": INSTALLATION_CREDENTIAL } });
  });

  it("sends canonical presence metadata and stops idempotently", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.service.register();
    await f.service.heartbeat();
    expect(f.client.updatePresence).toHaveBeenCalledWith(INSTALLATION_CREDENTIAL, {
      runtimeProfile: "headless-hub",
      appVersion: "0.1.37",
      capabilities: ["companion", "harness"],
    });
    f.service.stopPresence();
    f.service.stopPresence();
    await f.service.heartbeat();
    expect(f.client.updatePresence).toHaveBeenCalledTimes(1);
  });

  it("normalizes win32 to the canonical windows platform before registration", async () => {
    const f = fixture(); directories.push(f.dataDir);
    const service = createHubAccountService({
      client: f.client as never,
      identity: f.identity,
      profile: "headless-hub",
      platform: "win32" as never,
      appVersion: "0.1.37",
      displayName: "Windows Hub",
      secrets: f.secrets,
    });
    await service.verifyCode(EMAIL, "12345678");
    await service.register();
    expect(f.client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({ platform: "windows" }));
  });

  it("blocks registration when secret state is unavailable before network", async () => {
    const f = fixture(); directories.push(f.dataDir);
    const unavailable = { read: () => ({ status: "unavailable", values: {}, error: "unavailable" }), set: vi.fn(), delete: vi.fn() };
    const service = createHubAccountService({
      client: f.client as never,
      identity: f.identity,
      profile: "headless-hub",
      platform: "linux",
      appVersion: "0.1.37",
      displayName: "Home Hub",
      secrets: unavailable as never,
    });
    await expect(service.register()).rejects.toBeInstanceOf(HostSecretStoreUnavailableError);
    expect(f.client.ensureInstallation).not.toHaveBeenCalled();
  });

  it("waits for in-flight presence and sign-out keeps installation secrets", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.service.register();
    let resolvePresence!: () => void;
    const pending = new Promise<void>((resolve) => { resolvePresence = resolve; });
    f.client.updatePresence.mockReturnValueOnce(pending);
    const heartbeat = f.service.heartbeat();
    await Promise.resolve();
    const disposed = f.service.dispose();
    expect(f.client.updatePresence).toHaveBeenCalledTimes(1);
    let done = false;
    void disposed.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    resolvePresence();
    await disposed;
    await heartbeat;
    await f.service.signOut();
    const snapshot = f.secrets.read();
    expect(snapshot).toMatchObject({ status: "ok", values: {
      "controlPlane.accountEmail": EMAIL,
      "controlPlane.installationId": INSTALLATION_ID,
      "controlPlane.installationCredential": INSTALLATION_CREDENTIAL,
    } });
    expect((snapshot as { values: Record<string, string> }).values["controlPlane.accountToken"]).toBeUndefined();
    expect(existsSync(join(f.dataDir, "hub.json"))).toBe(true);
    expect(statSync(join(f.dataDir, "hub.json")).mode & 0o777).toBe(0o600);
    expect(f.client.signOut).toHaveBeenCalled();
  });

  it("fleet uses account bearer and returns no credential-shaped state", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await expect(f.service.fleet()).resolves.toEqual([fleet]);
    expect(f.client.listFleet).toHaveBeenCalledWith(ACCOUNT_TOKEN);
  });

  it("does not reuse an installation credential after the verified account changes", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.service.register();
    await f.service.signOut();
    f.client.verifyOTP.mockResolvedValueOnce({
      accountToken: `signed.${"d".repeat(40)}`,
      user: { id: "user-2", email: "other@example.com" },
    });
    await f.service.verifyCode("other@example.com", "12345678");
    const snapshot = f.secrets.read();
    expect(snapshot).toMatchObject({ status: "ok", values: {
      "controlPlane.accountEmail": "other@example.com",
      "controlPlane.accountUserId": "user-2",
    } });
    expect((snapshot as { values: Record<string, string> }).values["controlPlane.installationCredential"]).toBeUndefined();

    await f.service.register();
    expect(f.client.ensureInstallation).toHaveBeenLastCalledWith(expect.objectContaining({ currentCredential: "" }));
  });

  it("retains a credential for same-account recovery after sign-out", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.service.register();
    await f.service.signOut();
    await f.service.verifyCode(EMAIL, "12345678");
    await f.service.register();
    expect(f.client.ensureInstallation).toHaveBeenLastCalledWith(expect.objectContaining({
      currentCredential: INSTALLATION_CREDENTIAL,
    }));
  });

  it("ignores an unbound retained credential instead of replaying it", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.secrets.set("controlPlane.installationCredential", INSTALLATION_CREDENTIAL);
    await f.secrets.set("controlPlane.installationId", INSTALLATION_ID);
    await f.service.register();
    expect(f.client.ensureInstallation).toHaveBeenCalledWith(expect.objectContaining({ currentCredential: "" }));
  });

  it("removes malformed account bearer state on sign-out while retaining installation state", async () => {
    const f = fixture(); directories.push(f.dataDir);
    await f.service.verifyCode(EMAIL, "12345678");
    await f.service.register();
    await f.secrets.set(ACCOUNT_TOKEN_FIELD, `omb_install_malformed-${"x".repeat(20)}`);
    await f.service.signOut();
    const snapshot = f.secrets.read();
    expect(snapshot).toMatchObject({ status: "ok", values: {
      "controlPlane.accountEmail": EMAIL,
      "controlPlane.installationId": INSTALLATION_ID,
      "controlPlane.installationCredential": INSTALLATION_CREDENTIAL,
    } });
    expect((snapshot as { values: Record<string, string> }).values[ACCOUNT_TOKEN_FIELD]).toBeUndefined();
    expect(f.client.signOut).not.toHaveBeenCalled();
  });
});
