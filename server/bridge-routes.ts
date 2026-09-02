import type { IncomingMessage, ServerResponse } from "node:http";

import type { BridgeCapability, BridgeRegistry } from "./bridge-registry.ts";
import { IdempotencyConflictError } from "./bridge-registry.ts";
import { runShellOnBridge } from "./bridge-exec.ts";
import { ingestHermesEndpointDescriptors } from "./bridge-hermes.ts";

type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface BridgeRouteOpts {
  /** TCP loopback and not the companion sidecar. */
  direct: boolean;
  /** Request arrived via the companion sidecar. */
  companion: boolean;
  /** Direct loopback plus the operator admin token. */
  operator: boolean;
  /** Narrow Hermes MCP tool facade authenticated with the calling bridge. */
  hermesTools?: (input: {
    bridgeId: string;
    name: string;
    args: Record<string, unknown>;
    botScope: string;
  }) => Promise<{ status: number; body: unknown }>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function asCapabilities(value: unknown): BridgeCapability[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<BridgeCapability>(["shell", "local-vm", "ssh-forward", "hermes"]);
  return value.filter((entry): entry is BridgeCapability => typeof entry === "string" && allowed.has(entry as BridgeCapability));
}

export function isCompanionRequest(req: IncomingMessage): boolean {
  return req.headers["x-openmausbot-companion"] === "1";
}

/** Bridge HTTP surface. Returns true when the request was handled. */
export async function handleBridgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  json: JsonFn,
  bridges: BridgeRegistry,
  opts: BridgeRouteOpts,
): Promise<boolean> {
  if (!path.startsWith("/api/bridge")) return false;

  if (method === "POST" && path === "/api/bridge/pairing") {
    if (!opts.direct) return json(res, 403, { error: "pair bridges from the harness host" }), true;
    return json(res, 200, bridges.startPairing()), true;
  }

  if (method === "GET" && path === "/api/bridges") {
    if (!opts.direct && !opts.companion) return json(res, 403, { error: "bridge list is host or paired-phone only" }), true;
    return json(res, 200, { bridges: bridges.list() }), true;
  }

  const revokeMatch = path.match(/^\/api\/bridges\/([\w-]+)$/);
  if (revokeMatch && method === "DELETE") {
    if (!opts.direct && !opts.companion) return json(res, 403, { error: "bridge revoke is host or paired-phone only" }), true;
    const ok = bridges.revoke(revokeMatch[1]!);
    if (!ok) return json(res, 404, { error: "bridge not found" }), true;
    return json(res, 200, { ok: true, bridgeId: revokeMatch[1] }), true;
  }

  const jobMatch = path.match(/^\/api\/bridge\/jobs\/([\w-]+)$/);
  if (jobMatch) {
    if (!opts.direct || !opts.operator) {
      return json(res, 403, { error: "job administration requires operator authorization" }), true;
    }
    const jobId = jobMatch[1]!;
    if (method === "GET") {
      const record = bridges.getJob(jobId);
      if (!record) return json(res, 404, { error: "job not found" }), true;
      return json(res, 200, { job: record }), true;
    }
    if (method === "POST") {
      const body = await readJson(req);
      if (body.action !== "cancel") return json(res, 400, { error: "unsupported job action" }), true;
      const record = bridges.cancelJob(jobId);
      if (!record) return json(res, 404, { error: "job not found" }), true;
      return json(res, 200, { job: record }), true;
    }
  }

  if (method === "GET" && path === "/api/bridge/jobs") {
    if (!opts.direct || !opts.operator) {
      return json(res, 403, { error: "job administration requires operator authorization" }), true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const bridgeId = url.searchParams.get("bridgeId") ?? undefined;
    return json(res, 200, { jobs: bridges.listJobs(bridgeId) }), true;
  }

  const shellMatch = path.match(/^\/api\/bridges\/([\w-]+)\/shell$/);
  if (method === "POST" && shellMatch) {
    if (!opts.direct) return json(res, 403, { error: "bridge shell is harness-host only" }), true;
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
      const status = error instanceof IdempotencyConflictError ? 409 : 400;
      return json(res, status, { error: error instanceof Error ? error.message : String(error) }), true;
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
    const caps = body.capabilities === undefined ? undefined : asCapabilities(body.capabilities);
    bridges.touch(bridgeId, {
      hostInfo: body.hostInfo ? String(body.hostInfo) : undefined,
      capabilities: caps,
    });
    if (body.hermesEndpoints !== undefined) {
      ingestHermesEndpointDescriptors(bridgeId, body.hermesEndpoints);
    }
    return json(res, 200, { jobs: bridges.pollJobs(bridgeId), cancelJobIds: bridges.cancelRequests(bridgeId) }), true;
  }

  if (method === "POST" && path === "/api/bridge/result") {
    const body = await readJson(req);
    const jobId = String(body.jobId ?? "");
    if (!jobId) return json(res, 400, { error: "jobId required" }), true;
    if (!bridges.getJob(jobId)) return json(res, 404, { error: "unknown job" }), true;
    const stored = bridges.storeResult({
      jobId,
      bridgeId: bridge.id,
      exitCode: body.exitCode == null ? null : Number(body.exitCode),
      stdout: String(body.stdout ?? ""),
      stderr: String(body.stderr ?? ""),
      truncated: body.truncated === true,
      finishedAt: Date.now(),
      generation: body.generation == null ? undefined : Number(body.generation),
    });
    if (!stored) return json(res, 409, { error: "result rejected" }), true;
    return json(res, 200, { ok: true }), true;
  }

  if (method === "POST" && path === "/api/bridge/hermes-tools") {
    if (!opts.direct) return json(res, 403, { error: "Hermes tools are loopback-only" }), true;
    if (!opts.hermesTools) return json(res, 503, { error: "Hermes tools are unavailable" }), true;
    const body = await readJson(req);
    const { parseHermesBridgeToolRequest } = await import("./hermes-bridge-tools.ts");
    const parsed = parseHermesBridgeToolRequest(body);
    if ("error" in parsed) return json(res, 400, { error: parsed.error }), true;
    const result = await opts.hermesTools({
      bridgeId: bridge.id,
      name: parsed.name,
      args: parsed.args,
      botScope: parsed.botScope,
    });
    return json(res, result.status, result.body), true;
  }

  return json(res, 404, { error: `no route: ${method} ${path}` }), true;
}
