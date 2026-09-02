import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("Hermes V Bot connector transport", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-loopback TCP bind", async () => {
    const { startHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    await expect(
      startHermesVbotConnector({
        listen: { host: "0.0.0.0", port: 0 },
        peerCredential: "peer-cred",
        botScope: "bot-1",
      }),
    ).rejects.toMatchObject({ code: "loopback_required" });
  });

  it("closes clients that omit the local peer credential", async () => {
    const { startHermesVbotConnector, connectHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-connector-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const server = await startHermesVbotConnector({
      listen: { socketPath },
      peerCredential: "peer-cred",
      botScope: "bot-1",
    });
    await expect(
      connectHermesVbotConnector({ socketPath, peerCredential: "" }),
    ).rejects.toMatchObject({ code: "peer_unauthenticated" });
    await server.close();
  });

  it("correlates JSON-RPC ids across a reconnect", async () => {
    const { startHermesVbotConnector, connectHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-connector-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const server = await startHermesVbotConnector({
      listen: { socketPath },
      peerCredential: "peer-cred",
      botScope: "bot-1",
      handler: async (request) => ({ jsonrpc: "2.0", id: request.id, result: { echo: request.method } }),
    });
    const first = await connectHermesVbotConnector({ socketPath, peerCredential: "peer-cred" });
    const ping = await first.request("ping", { n: 1 });
    expect(ping).toEqual({ echo: "ping" });
    first.close();
    const second = await connectHermesVbotConnector({ socketPath, peerCredential: "peer-cred" });
    const pong = await second.request("pong", { n: 2 });
    expect(pong).toEqual({ echo: "pong" });
    second.close();
    await server.close();
  });

  it("rejects oversized payloads without echoing them", async () => {
    const { startHermesVbotConnector, connectHermesVbotConnector, HERMES_VBOT_MAX_PAYLOAD_BYTES } = await import(
      "./hermes-vbot-connector.ts"
    );
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-connector-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const logs: string[] = [];
    const server = await startHermesVbotConnector({
      listen: { socketPath },
      peerCredential: "peer-cred",
      botScope: "bot-1",
      log: (line) => logs.push(line),
    });
    const client = await connectHermesVbotConnector({ socketPath, peerCredential: "peer-cred" });
    const huge = "x".repeat(HERMES_VBOT_MAX_PAYLOAD_BYTES + 8);
    await expect(client.request("overflow", { blob: huge })).rejects.toMatchObject({ code: "payload_too_large" });
    expect(logs.join("\n")).not.toContain(huge);
    expect(logs.join("\n")).not.toContain("peer-cred");
    client.close();
    await server.close();
  });

  it("never binds a TCP server that is not loopback", async () => {
    const { startHermesVbotConnector } = await import("./hermes-vbot-connector.ts");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    server.close();
    const started = await startHermesVbotConnector({
      listen: { host: "127.0.0.1", port: 0 },
      peerCredential: "peer-cred",
      botScope: "bot-1",
    });
    expect(started.address).toMatchObject({ host: "127.0.0.1" });
    await started.close();
  });

  it("starts a loopback daemon listener from bridge identity without putting tokens in argv", async () => {
    const { daemonHermesVbotConnectorOptions, startHermesVbotConnector, connectHermesVbotConnector } = await import(
      "./hermes-vbot-connector.ts"
    );
    const dir = mkdtempSync(join(tmpdir(), "vbot-hermes-connector-"));
    dirs.push(dir);
    const socketPath = join(dir, "vbot.sock");
    const options = daemonHermesVbotConnectorOptions({
      bridgeId: "bridge-mini",
      bridgeToken: "bridge-token-secret",
      socketPath,
      botScope: "bot-chief",
    });
    expect(options.peerCredential).toBe("bridge-mini");
    expect(options.peerCredential).not.toMatch(/token|secret|Bearer/i);
    expect(JSON.stringify(options)).not.toMatch(/bridge-token-secret|OMB_COMMS|Bearer/i);
    expect(options.listen).toEqual({ socketPath });
    const server = await startHermesVbotConnector({
      ...options,
      handler: async (request) => ({ jsonrpc: "2.0", id: request.id, result: { method: request.method } }),
    });
    const client = await connectHermesVbotConnector({
      socketPath,
      peerCredential: "bridge-mini",
      botScope: "bot-chief",
    });
    await expect(client.request("tools/list")).resolves.toEqual({ method: "tools/list" });
    client.close();
    await server.close();
  });
});
