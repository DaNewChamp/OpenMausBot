import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAuth } from "../src/auth";
import { readConfig } from "../src/config";
import worker from "../src/index";

const BASE_URL = "https://auth.openmausbot.test";

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function call(path: string, options: CallOptions = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  let body: BodyInit | undefined;
  if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const request = new Request(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp, name: email.split("@", 1)[0] },
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("missing account bearer");
  const payload = await response.json<{ user: { id: string } }>();
  return { token, userId: payload.user.id };
}

async function createInstallation(token: string, clientInstanceId: string = crypto.randomUUID()) {
  const response = await call("/v1/installations", {
    method: "POST",
    token,
    body: { clientInstanceId, name: "Fleet hub", platform: "darwin", appVersion: "0.1.0" },
  });
  expect(response.status).toBe(201);
  return response.json<{
    installation: { id: string; clientInstanceId: string };
    credential: string;
  }>();
}

describe("fleet presence authentication and validation", () => {
  it("records normalized presence with an installation credential", async () => {
    const account = await signIn("presence-owner@example.com");
    const created = await createInstallation(account.token, "legacy-client-instance-A");

    const response = await call("/v1/installations/self/presence", {
      method: "PUT",
      token: created.credential,
      body: {
        runtimeProfile: "headless-hub",
        appVersion: " 0.1.37 ",
        capabilities: ["managed-endpoint", "companion", "companion"],
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const row = await env.DB.prepare(
      "SELECT runtime_profile, app_version, capabilities_json, last_seen_at, presence_updated_at, updated_at FROM installations WHERE id = ?",
    ).bind(created.installation.id).first<{
      runtime_profile: string;
      app_version: string;
      capabilities_json: string;
      last_seen_at: number | null;
      presence_updated_at: number | null;
      updated_at: number;
    }>();
    expect(row).toMatchObject({
      runtime_profile: "headless-hub",
      app_version: "0.1.37",
      capabilities_json: '["companion","managed-endpoint"]',
    });
    expect(row?.last_seen_at).toEqual(expect.any(Number));
    expect(row?.presence_updated_at).toEqual(expect.any(Number));
    expect(row?.updated_at).toEqual(expect.any(Number));
  });

  it("keeps account and installation credentials on separate routes", async () => {
    const account = await signIn("presence-auth-boundary@example.com");
    const created = await createInstallation(account.token);
    const body = { runtimeProfile: "desktop-hub", capabilities: [] };

    expect((await call("/v1/installations/self/presence", {
      method: "PUT",
      token: account.token,
      body,
    })).status).toBe(401);
    expect((await call("/v1/fleet", { token: created.credential })).status).toBe(401);
  });

  it("rejects unknown profiles, extra keys, invalid capabilities, and win32", async () => {
    const account = await signIn("presence-validation@example.com");
    const created = await createInstallation(account.token);
    const cases: unknown[] = [
      { runtimeProfile: "node-only", capabilities: [] },
      { runtimeProfile: "desktop-hub", capabilities: [], unexpected: true },
      { runtimeProfile: "desktop-hub", capabilities: ["Companion"] },
      { runtimeProfile: "desktop-hub", capabilities: ["bad value"] },
      { runtimeProfile: "desktop-hub", capabilities: Array.from({ length: 33 }, () => "companion") },
      { runtimeProfile: "desktop-hub", capabilities: "companion" },
    ];
    for (const body of cases) {
      const response = await call("/v1/installations/self/presence", {
        method: "PUT",
        token: created.credential,
        body,
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }

    const win32 = await call("/v1/installations", {
      method: "POST",
      token: account.token,
      body: { clientInstanceId: "win32-client", name: "Windows", platform: "win32" },
    });
    expect(win32.status).toBe(400);
  });

  it("accepts opaque legacy client IDs and rejects unsafe IDs", async () => {
    const account = await signIn("opaque-id-owner@example.com");
    const accepted = await createInstallation(account.token, "legacy-client-instance-A");
    expect(accepted.installation.clientInstanceId).toBe("legacy-client-instance-A");

    const invalid: unknown[] = ["", "x".repeat(257), "bad\u0000id", 42, null];
    for (const clientInstanceId of invalid) {
      const response = await call("/v1/installations", {
        method: "POST",
        token: account.token,
        body: { clientInstanceId, name: "Fleet hub", platform: "darwin" },
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    }
  });
});

describe("fleet listing", () => {
  it("defaults legacy rows, isolates owners, and reports online through the TTL", async () => {
    const owner = await signIn("fleet-owner@example.com");
    const other = await signIn("fleet-other@example.com");
    const first = await createInstallation(owner.token, "legacy-fleet-client");
    await createInstallation(other.token, "other-fleet-client");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE installations SET presence_updated_at = ? WHERE id = ?")
        .bind(now - 60_000, first.installation.id),
    ]);

    const response = await call("/v1/fleet", { token: owner.token });
    expect(response.status).toBe(200);
    const payload = await response.json<{
      installations: Array<{
        id: string;
        clientInstanceId: string;
        runtimeProfile: string;
        capabilities: string[];
        online: boolean;
      }>;
    }>();
    expect(payload.installations).toHaveLength(1);
    expect(payload.installations[0]).toMatchObject({
      id: first.installation.id,
      clientInstanceId: "legacy-fleet-client",
      runtimeProfile: "desktop-hub",
      capabilities: [],
      online: true,
    });

    await env.DB.prepare("UPDATE installations SET presence_updated_at = ? WHERE id = ?")
      .bind(Date.now() - 90_001, first.installation.id).run();
    const expired = await call("/v1/fleet", { token: owner.token });
    expect((await expired.json<typeof payload>()).installations[0]?.online).toBe(false);
  });

  it("publishes only safe HTTPS endpoint metadata and redacts provider/account fields", async () => {
    const owner = await signIn("fleet-safe-owner@example.com");
    const created = await createInstallation(owner.token, "safe-fleet-client");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO installation_endpoints
        (installation_id, hostname, tunnel_name, tunnel_id, dns_record_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ).bind(
      created.installation.id,
      "c-safe.example.test",
      "opaque-tunnel-name",
      "tunnel-secret-id",
      "dns-secret-id",
      now,
      now,
    ).run();

    const response = await call("/v1/fleet", { token: owner.token });
    const payload = await response.json<{ installations: Array<Record<string, unknown>> }>();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(created.credential);
    expect(serialized).not.toContain("tunnel-secret-id");
    expect(serialized).not.toContain("dns-secret-id");
    expect(serialized).not.toContain(owner.userId);
    expect(serialized).not.toContain("fleet-safe-owner@example.com");
    expect(payload.installations[0]).toMatchObject({
      endpoint: { url: "https://c-safe.example.test", status: "ready" },
    });
    expect(Object.keys(payload.installations[0]?.endpoint as object)).toEqual(["url", "status"]);

    await env.DB.prepare("UPDATE installation_endpoints SET status = 'deleted' WHERE installation_id = ?")
      .bind(created.installation.id).run();
    const deleted = await call("/v1/fleet", { token: owner.token });
    expect((await deleted.json<typeof payload>()).installations[0]?.endpoint).toBeNull();
  });

  it("fails safe for corrupted stored profile and capabilities values", async () => {
    const owner = await signIn("fleet-corrupt-owner@example.com");
    const created = await createInstallation(owner.token, "corrupt-fleet-client");
    await env.DB.prepare(
      "UPDATE installations SET runtime_profile = ?, capabilities_json = ? WHERE id = ?",
    ).bind("future-profile", "{not-json", created.installation.id).run();

    const response = await call("/v1/fleet", { token: owner.token });
    expect((await response.json<{ installations: Array<{ runtimeProfile: string; capabilities: string[] }> }>())
      .installations[0]).toMatchObject({ runtimeProfile: "desktop-hub", capabilities: [] });
  });
});
