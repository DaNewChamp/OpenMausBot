import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ControlPlaneError,
  createControlPlaneClient,
  decodeFleetResponse,
} from "./control-plane-client.mjs";

const ACCOUNT = `signed.${"a".repeat(40)}`;
const INSTALL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const fleetInstallation = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  clientInstanceId: "22222222-2222-4222-8222-222222222222",
  name: "Home hub",
  platform: "linux",
  runtimeProfile: "headless-hub",
  appVersion: "0.1.37",
  capabilities: ["companion"],
  lastSeenAt: 1700000000000,
  online: true,
  endpoint: {
    url: "https://c-0123456789abcdef0123456789abcdef.example.com",
    status: "ready",
  },
});
const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("shared control-plane fleet client", () => {
  it("decodes only the safe fleet installation shape", () => {
    assert.deepEqual(
      decodeFleetResponse({ installations: [fleetInstallation()] }),
      [fleetInstallation()],
    );
  });

  it("lists fleet records with the account bearer and no credential-shaped fields", async () => {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.equal(url, "https://accounts.openmausbot.com/v1/fleet");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.get("authorization"), `Bearer ${ACCOUNT}`);
      assert.equal(init.headers.get("origin"), null);
      assert.equal(init.redirect, "error");
      return jsonResponse({ installations: [fleetInstallation()] });
    };
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    assert.deepEqual(await client.listFleet(ACCOUNT), [fleetInstallation()]);
    assert.equal(calls, 1);
  });

  it("rejects malformed fleet records instead of passing them through", () => {
    const invalid = [
      ["unknown top-level", { installations: [], leakedToken: "secret" }],
      ["unknown installation key", { installations: [{ ...fleetInstallation(), credential: "secret" }] }],
      ["unknown endpoint key", { installations: [{ ...fleetInstallation(), endpoint: { ...fleetInstallation().endpoint, token: "secret" } }] }],
      ["bad installation id", { installations: [{ ...fleetInstallation(), id: "bad\u0000id" }] }],
      ["bad client id", { installations: [{ ...fleetInstallation(), clientInstanceId: "" }] }],
      ["bad platform", { installations: [{ ...fleetInstallation(), platform: "win32" }] }],
      ["bad profile", { installations: [{ ...fleetInstallation(), runtimeProfile: "node-only" }] }],
      ["bad capability", { installations: [{ ...fleetInstallation(), capabilities: ["Companion"] }] }],
      ["duplicate capability", { installations: [{ ...fleetInstallation(), capabilities: ["companion", "companion"] }] }],
      ["oversized capabilities", { installations: [{ ...fleetInstallation(), capabilities: Array.from({ length: 33 }, (_, i) => `cap-${i}`) }] }],
      ["oversized fleet", { installations: Array.from({ length: 101 }, fleetInstallation) }],
      ["invalid timestamp", { installations: [{ ...fleetInstallation(), lastSeenAt: -1 }] }],
      ["invalid timestamp type", { installations: [{ ...fleetInstallation(), lastSeenAt: 1.5 }] }],
      ["non-HTTPS endpoint", { installations: [{ ...fleetInstallation(), endpoint: { url: "http://c.example.com", status: "ready" } }] }],
      ["endpoint path", { installations: [{ ...fleetInstallation(), endpoint: { url: "https://c.example.com/path", status: "ready" } }] }],
      ["unknown endpoint status", { installations: [{ ...fleetInstallation(), endpoint: { url: "https://c.example.com", status: "unknown" } }] }],
    ];
    for (const [label, payload] of invalid) {
      assert.equal(decodeFleetResponse(payload), null, label);
    }
  });

  it("retains opaque printable IDs and allows installations without endpoints", () => {
    const record = fleetInstallation();
    record.id = "legacy/installation.id: A_01+stable";
    record.clientInstanceId = "legacy/client.instance: A_01+stable";
    record.endpoint = null;
    record.lastSeenAt = null;
    assert.deepEqual(decodeFleetResponse({ installations: [record] }), [record]);
  });

  it("sends installation-authenticated presence with the exact body", async () => {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.equal(url, "https://accounts.openmausbot.com/v1/installations/self/presence");
      assert.equal(init.method, "PUT");
      assert.equal(init.headers.get("authorization"), `Bearer ${INSTALL}`);
      assert.equal(init.headers.get("origin"), null);
      assert.equal(init.redirect, "error");
      assert.equal(init.body, JSON.stringify({
        runtimeProfile: "headless-hub",
        appVersion: "0.1.37",
        capabilities: ["companion", "harness"],
      }));
      return jsonResponse({ ok: true });
    };
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await client.updatePresence(INSTALL, {
      runtimeProfile: "headless-hub",
      appVersion: "0.1.37",
      capabilities: ["companion", "harness"],
    });
    assert.equal(calls, 1);
  });

  it("does not accept an account bearer for installation presence", async () => {
    let calls = 0;
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    });
    await assert.rejects(
      client.updatePresence(ACCOUNT, {
        runtimeProfile: "headless-hub",
        appVersion: "0.1.37",
        capabilities: [],
      }),
      (error) => error instanceof ControlPlaneError && error.code === "signed_out" && error.status === 401,
    );
    assert.equal(calls, 0);
  });

  it("rejects unsafe presence input before making a request", async () => {
    let calls = 0;
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    });
    for (const presence of [
      { runtimeProfile: "unknown", capabilities: [] },
      { runtimeProfile: "headless-hub", capabilities: ["Bad"] },
      { runtimeProfile: "headless-hub", capabilities: ["companion", "companion"] },
      { runtimeProfile: "headless-hub", capabilities: [], credential: "secret" },
    ]) {
      await assert.rejects(
        client.updatePresence(INSTALL, presence),
        (error) => error instanceof ControlPlaneError && error.code === "invalid_request",
      );
    }
    assert.equal(calls, 0);
  });

  it("fails closed when the fleet response is not strict JSON", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: async () => jsonResponse({
        installations: [{ ...fleetInstallation(), secret: "do-not-pass" }],
      }),
    });
    await assert.rejects(
      client.listFleet(ACCOUNT),
      (error) => error instanceof ControlPlaneError && error.code === "invalid_response",
    );
  });

  it("rejects account and installation calls with empty credentials", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    await assert.rejects(client.listFleet(""), ControlPlaneError);
    await assert.rejects(client.updatePresence("", {
      runtimeProfile: "headless-hub",
      capabilities: [],
    }), ControlPlaneError);
  });
});
