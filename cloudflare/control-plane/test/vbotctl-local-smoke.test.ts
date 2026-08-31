import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// Keep NodeNext runtime sources out of the Worker package's TypeScript
// program while Vitest still loads the real modules at runtime.
// @ts-expect-error JavaScript test adapter intentionally has no declarations.
import { createControlPlaneClient, createHubAccountService, runVbotctl } from "./runtime-adapter.mjs";
import { createWorker } from "../src/index";
import { createLocalMailFixture } from "./local-mail-fixture";

const LOOPBACK_URL = "http://127.0.0.1:8787";
const FIXTURE_ORIGIN = "https://control-plane.fixture.test";
const EMAIL = "fixture-user@example.com";
const registeredStateSchema = z.object({
  accountEmail: z.string(),
  installationId: z.string(),
  credentialExpiresAt: z.number(),
});
const fleetStateSchema = z.array(z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  name: z.string(),
  platform: z.string(),
  runtimeProfile: z.string(),
  appVersion: z.string().nullable(),
  capabilities: z.array(z.string()),
  lastSeenAt: z.number().nullable(),
  online: z.boolean(),
  endpoint: z.null(),
}));

interface Invocation {
  code: number;
  stdout: string;
  stderr: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invoke(
  dataDir: string,
  service: ReturnType<typeof createHubAccountService>,
  args: string[],
  stdin?: string,
): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  return runVbotctl(["--data-dir", dataDir, ...args], {
    stdin: Readable.from(stdin === undefined ? [] : [stdin]),
    stdout: { write: (chunk: string) => { stdout += chunk; } },
    stderr: { write: (chunk: string) => { stderr += chunk; } },
    service,
  }).then((code: number) => ({ code, stdout, stderr }));
}

describe("headless vbotctl local control-plane smoke", () => {
  it("runs OTP, registration, presence, fleet, restart, and outage paths through the Worker", async () => {
    // Workers pool does not expose host filesystem state. The CLI's service
    // dependency is therefore backed by this disposable in-memory fixture,
    // while the command still receives the same explicit absolute path a
    // headless invocation would use.
    const dataDir = `/tmp/vbotctl-control-plane-smoke-${crypto.randomUUID()}`;
    const mail = createLocalMailFixture();
    const values = new Map<string, string>();
    const secrets = {
      read: () => {
        const snapshot = Object.fromEntries(values);
        return Object.keys(snapshot).length === 0
          ? { status: "empty" as const, values: {} }
          : { status: "ok" as const, values: snapshot };
      },
      set: (name: string, value: string) => { values.set(name, value); },
      delete: (name: string) => { values.delete(name); },
    };
    const identity = { schemaVersion: 1 as const, id: "fixture-hub-id", createdAt: 1 };
    const fixtureEnv = { ...env };
    Object.assign(fixtureEnv, {
      BETTER_AUTH_URL: FIXTURE_ORIGIN,
      ALLOWED_ORIGINS: FIXTURE_ORIGIN,
      EMAIL: mail.EMAIL,
    });
    const localWorker = createWorker();
    const requests: Array<{ url: string; method: string; body: string }> = [];
    let workerRunning = true;

    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (!workerRunning) throw new Error("local Worker stopped");
      const source = new URL(input);
      const target = new URL(FIXTURE_ORIGIN);
      target.pathname = source.pathname;
      target.search = source.search;
      const headers = new Headers(init?.headers);
      if (headers.has("origin")) headers.set("origin", FIXTURE_ORIGIN);
      const body = String(init?.body ?? "");
      requests.push({ url: source.origin + source.pathname, method: init?.method ?? "GET", body });
      const context = createExecutionContext();
      const response = await localWorker.fetch(new Request(target, {
        ...init,
        redirect: "manual",
        headers,
      }), fixtureEnv, context);
      await waitOnExecutionContext(context);
      return response;
    };
    const service = () => createHubAccountService({
      client: createControlPlaneClient({ baseURL: LOOPBACK_URL, fetchImpl }),
      identity,
      profile: "headless-hub",
      platform: "darwin",
      appVersion: "0.1.37",
      displayName: "Fixture Hub",
      secrets,
    });

    try {
      const requested = await invoke(dataDir, service(), [
        "account", "request-code", "--email", EMAIL,
      ]);

      expect(requested.code).toBe(0);
      expect(requested.stderr).toBe("");
      expect(JSON.parse(requested.stdout)).toEqual({ email: EMAIL });
      const otp = mail.readLatestOtp(EMAIL);
      expect(otp).toMatch(/^\d{8}$/);
      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          url: `${LOOPBACK_URL}/api/auth/email-otp/send-verification-otp`,
          method: "POST",
        }),
      ]));

      const verified = await invoke(dataDir, service(), [
        "account", "verify-code", "--email", EMAIL, "--stdin",
      ], `${otp}\n`);
      expect(verified.code).toBe(0);
      expect(verified.stderr).toBe("");
      expect(JSON.parse(verified.stdout)).toEqual({ accountEmail: EMAIL });
      expect(requests.at(-1)?.url).toBe(`${LOOPBACK_URL}/api/auth/sign-in/email-otp`);
      expect(JSON.parse(requests.at(-1)?.body ?? "{}").otp).toBe(otp);

      const registered = await invoke(dataDir, service(), [
        "hub", "register", "--name", "Fixture Hub",
      ]);
      expect(registered.code).toBe(0);
      expect(registered.stderr).toBe("");
      const registeredState = registeredStateSchema.parse(JSON.parse(registered.stdout));
      expect(registeredState.accountEmail).toBe(EMAIL);
      expect(registeredState.installationId).toMatch(/^[^\s]+$/);
      expect(registeredState.credentialExpiresAt).toBeGreaterThan(Date.now());

      const heartbeat = await invoke(dataDir, service(), ["hub", "heartbeat", "--once"]);
      expect(heartbeat).toEqual({ code: 0, stdout: "{\"ok\":true}\n", stderr: "" });

      const fleet = await invoke(dataDir, service(), ["fleet", "list", "--json"]);
      expect(fleet.code).toBe(0);
      expect(fleet.stderr).toBe("");
      const fleetState = fleetStateSchema.parse(JSON.parse(fleet.stdout));
      expect(fleetState).toHaveLength(1);
      expect(fleetState[0]).toMatchObject({
        id: registeredState.installationId,
        clientInstanceId: expect.any(String),
        name: "Fixture Hub",
        platform: "darwin",
        runtimeProfile: "headless-hub",
        capabilities: ["companion", "harness"],
        online: true,
        endpoint: null,
      });

      const identityBeforeRestart = identity.id;
      const envelopeBeforeRestart = hashText(JSON.stringify([...values].sort()));
      const restarted = await invoke(dataDir, service(), [
        "hub", "register", "--name", "Fixture Hub",
      ]);
      expect(restarted.code).toBe(0);
      expect(JSON.parse(restarted.stdout)).toEqual(registeredState);
      expect(identity.id).toBe(identityBeforeRestart);
      expect(hashText(JSON.stringify([...values].sort()))).toBe(envelopeBeforeRestart);
      const installationCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM installations",
      ).first<{ count: number }>();
      expect(installationCount?.count).toBe(1);

      workerRunning = false;
      const identityBeforeOutage = hashText(JSON.stringify(identity));
      const envelopeBeforeOutage = hashText(JSON.stringify([...values].sort()));
      const failedHeartbeat = await invoke(dataDir, service(), ["hub", "heartbeat", "--once"]);
      const failedFleet = await invoke(dataDir, service(), ["fleet", "list", "--json"]);
      expect(failedHeartbeat).toEqual({ code: 1, stdout: "", stderr: "network_unavailable\n" });
      expect(failedFleet).toEqual({ code: 1, stdout: "", stderr: "network_unavailable\n" });
      expect(hashText(JSON.stringify(identity))).toBe(identityBeforeOutage);
      expect(hashText(JSON.stringify([...values].sort()))).toBe(envelopeBeforeOutage);

      const output = [requested, verified, registered, heartbeat, fleet, restarted, failedHeartbeat, failedFleet]
        .map(({ stdout, stderr }) => `${stdout}${stderr}`)
        .join("");
      expect(output).not.toMatch(/omb_install_/);
      for (const [name, value] of values) {
        if (name === "controlPlane.accountToken" || name === "controlPlane.installationCredential") {
          expect(output.includes(value)).toBe(false);
        }
      }
      expect(requests.some(({ url }) => url.startsWith(LOOPBACK_URL))).toBe(true);
      expect(requests.every(({ url }) => url.startsWith(LOOPBACK_URL))).toBe(true);
    } finally {
      mail.clear();
      values.clear();
    }
  });
});
