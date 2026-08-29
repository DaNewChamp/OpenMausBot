import type { IncomingMessage, ServerResponse } from "node:http";

import type { BridgeCapability, BridgeRegistry } from "./bridge-registry.ts";
import { runShellOnBridge } from "./bridge-exec.ts";

type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function asCapabilities(value: unknown): BridgeCapability[] {
  if (!Array.isArray(value)) return ["shell"];
  const allowed = new Set<BridgeCapability>(["shell", "local-vm", "ssh-forward"]);
  return value.filter((entry): entry is BridgeCapability => typeof entry === "string" && allowed.has(entry as BridgeCapability));
}

/** Bridge HTTP surface. Returns true when the request was handled. */
export async function handleBridgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  json: JsonFn,
  bridges: BridgeRegistry,
  opts: { loopback: boolean },
): Promise<boolean> {
  if (!path.startsWith("/api/bridge")) return false;

  if (method === "POST" && path === "/api/bridge/pairing") {
    if (!opts.loopback) return json(res, 403, { error: "pair bridges from the harness host" }), true;
    return json(res, 200, bridges.startPairing()), true;
  }

  if (method === "GET" && path === "/api/bridges") {
    if (!opts.loopback) return json(res, 403, { error: "bridge list is loopback-only" }), true;
    return json(res, 200, { bridges: bridges.list() }), true;
  }

  const shellMatch = path.match(/^\/api\/bridges\/([\w-]+)\/shell$/);
  if (method === "POST" && shellMatch && opts.loopback) {
    try {
      const body = await readJson(req);
      const result = await runShellOnBridge(bridges, {
        bridgeId: shellMatch[1],
        name: body.name ? String(body.name) : undefined,
        command: String(body.command ?? ""),
        cwd: body.cwd ? String(body.cwd) : undefined,
        timeoutMs: body.timeoutMs == null ? undefined : Number(body.timeoutMs),
      });
      return json(res, 200, result), true;
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) }), true;
    }
  }

  if (method === "POST" && path === "/api/bridge/register") {
    try {
      const body = await readJson(req);
      const registered = bridges.register({
        name: String(body.name ?? ""),
        code: body.code ? String(body.code) : undefined,
        pairingToken: body.pairingToken ? String(body.pairingToken) : undefined,
        capabilities: asCapabilities(body.capabilities),
        hostInfo: body.hostInfo ? String(body.hostInfo) : undefined,
      });
      return json(res, 200, registered), true;
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) }), true;
    }
  }

  const bridge = bridges.authorize(req.headers.authorization);
  if (!bridge) return json(res, 401, { error: "unauthorized bridge" }), true;

  if (method === "POST" && path === "/api/bridge/heartbeat") {
    const body = await readJson(req);
    const bridgeId = String(body.bridgeId ?? bridge.id);
    if (bridgeId !== bridge.id) return json(res, 403, { error: "bridge id mismatch" }), true;
    const caps = asCapabilities(body.capabilities);
    bridges.touch(bridgeId, {
      hostInfo: body.hostInfo ? String(body.hostInfo) : undefined,
      capabilities: caps.length ? caps : undefined,
    });
    return json(res, 200, { jobs: bridges.pollJobs(bridgeId) }), true;
  }

  if (method === "POST" && path === "/api/bridge/result") {
    const body = await readJson(req);
    const jobId = String(body.jobId ?? "");
    if (!jobId) return json(res, 400, { error: "jobId required" }), true;
    bridges.storeResult({
      jobId,
      bridgeId: bridge.id,
      exitCode: body.exitCode == null ? null : Number(body.exitCode),
      stdout: String(body.stdout ?? ""),
      stderr: String(body.stderr ?? ""),
      finishedAt: Date.now(),
    });
    return json(res, 200, { ok: true }), true;
  }

  return json(res, 404, { error: `no route: ${method} ${path}` }), true;
}
