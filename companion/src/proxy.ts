// The forwarding half of the sidecar.
//
// A device's request arrives here, is checked against the allowlist, and is
// replayed to the harness on 127.0.0.1 as a request from this machine. The
// response comes back scrubbed.
//
// The reason this works with an unmodified harness is worth stating plainly,
// because it is the whole basis of the design: the harness rejects any
// request whose Host is not loopback — a DNS-rebinding defence — and a
// request this process makes to 127.0.0.1 satisfies that by construction. So
// the sidecar does NOT forward the device's Host or Origin. It speaks to the
// harness as itself, from the machine the harness is already willing to
// serve. Nothing upstream has to change, or even know this exists.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import { bearerToken } from "./devices.ts";
import {
  COMPANION_ENDPOINT_KINDS,
  MAX_COMPANION_ENDPOINTS,
  type CompanionEndpoint,
} from "./endpoints.ts";
import {
  denyReason,
  isCloudDesktopJoin,
  isBotModel,
  isBotUnread,
  isBotVisibility,
  isComputerDestination,
  isConnectorCardAction,
  isConnectorCardStatus,
  isGroupSetup,
  isGroupUnread,
  isLocalVmAction,
  isLocalVmScreenshot,
  isLocalVmJoin,
  isLocalVmInput,
  isLocalVmViewer,
  isLocalVmPhoneSurface,
  isLocalVmViewerUpgrade,
  localVmViewerBotId,
  validateBotModelBody,
  validateBotVisibilityBody,
  validateComputerDestinationBody,
  validateConnectorCardBody,
  validateConnectorCardThreadId,
  validateGroupSetupBody,
  validateLocalVmActionBody,
  botModelBotId,
  botUnreadBotId,
  botVisibilityBotId,
  computerDestinationBotId,
  groupSetupRoomId,
  groupUnreadRoomId,
} from "./routes.ts";
import {
  appendViewerAccessQuery,
  mintViewerAccessToken,
  resolveViewerAccessDeviceId,
  stripViewerAccessQuery,
  viewerAccessSetCookieForRequest,
} from "./viewer-access.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";

/** What the forwarding handler needs from the process around it. */
export interface ProxyOptions {
  /** Where the harness is listening on loopback. */
  harnessPort: number;
  authenticate: (token: string | undefined) => {
    id?: string;
    cloudDesktopAccess: boolean;
    localVmAccess?: boolean;
  } | null;
  /** Redeem a pairing code. Handled here and never forwarded: the harness
   * has no such route and no idea devices exist — pairing is the sidecar's
   * own concern, and the one thing a device does before it has a token. */
  redeem: (
    code: string,
    deviceName: unknown,
    pairRequestId?: unknown,
  ) => { token: string; device: unknown } | { error: string };
  /** What the phone should call this computer in its connection list. */
  serverName: () => string;
  /** Every host the phone could dial later, best first — sent with the
   * pairing response so the app can fall back when the address it paired on
   * stops resolving. Optional and advisory: a phone that never receives it
   * simply keeps dialing the one host it paired with. */
  hosts?: () => string[];
  /** Complete connection URLs for current mobile clients. `hosts` remains
   * alongside this field for builds that predate typed endpoints. */
  endpoints?: () => CompanionEndpoint[];
  /** Register one authenticated, live event stream. The tracker can terminate
   * it synchronously when that device is revoked; the returned disposer is
   * called exactly once when either side closes it. */
  connected?: (deviceId: string, disconnect: () => void) => () => void;
  /** How long the harness may take to produce response *headers*. Optional,
   * and only ever set by tests — the default is the one that ships. */
  headersTimeoutMs?: number;
  /** Persist Local VM access for this paired device. Choosing Local VM on
   * the phone is the consent; the Mac Companion toggle remains the revoke. */
  grantLocalVmAccess?: (deviceId: string) => boolean;
  /** Resolve a paired device by id for scoped viewer tickets. */
  deviceById?: (deviceId: string) => {
    id?: string;
    cloudDesktopAccess: boolean;
    localVmAccess?: boolean;
  } | null;
}

export interface CompanionEndpointSnapshot {
  serverName: string;
  endpoints: CompanionEndpoint[];
}

/** The harness has this long to send a status line and headers.
 *
 * Headers only. Once they arrive the clock is off and the body may take as
 * long as it likes, which is the whole point: an SSE stream is a response
 * that deliberately never ends, and a timeout that could not tell the
 * difference would cut every live stream at thirty seconds. */
const HEADERS_TIMEOUT_MS = 30_000;

/** A JSON response has to be buffered whole before it can be scrubbed, so the
 * buffer is the size of the response and nothing upstream promises that is
 * small. Far above any real payload — it exists to have a ceiling at all. */
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/** Read a JSON body, bounded. An unbounded read on an unauthenticated route
 * is a way to be memory-exhausted by anyone who can reach the port. */
const readJson = (
  req: IncomingMessage,
  limit = 64 * 1024,
  requireObject = false,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        if (requireObject) return reject(new Error("JSON body must be an object"));
        return resolve({});
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (requireObject && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
          return reject(new Error("JSON body must be an object"));
        }
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });

/** Answer with JSON the sidecar wrote itself — a refusal, or a pairing
 * result. Anything from the harness goes out through the proxy path instead.
 *
 * Unless the response has already begun. Once a byte is on the wire the
 * status line is spent and `writeHead` throws ERR_HTTP_HEADERS_SENT, which
 * on the failure paths — an upstream dying long after SSE headers were
 * flushed — would be a second, fatal error raised inside an error handler
 * with nothing to catch it. Dropping the socket is the only honest ending
 * left there: the device sees a truncated response and reconnects, which is
 * what it already does for any dropped connection. */
const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  pragma: "no-cache",
  vary: "Authorization",
} as const;

/** Device responses can cross a public CDN when the managed HTTPS endpoint
 * is enabled. Never let chat JSON, images, audio, pairing responses, or even
 * authorization failures become shared cache entries. These values override
 * anything the loopback harness supplied. */
const privateHeaders = (headers: IncomingMessage["headers"] = {}): IncomingMessage["headers"] => ({
  ...headers,
  ...PRIVATE_RESPONSE_HEADERS,
});

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...PRIVATE_RESPONSE_HEADERS,
  });
  res.end(text);
};

/** Reduce live endpoint metadata to the same tiny public shape returned at
 * pairing time. The hook is internal, but this still validates and caps it at
 * the network boundary so a future producer cannot accidentally publish an
 * extra field, path-bearing URL, or unbounded list. */
const endpointSnapshot = (options: ProxyOptions): CompanionEndpointSnapshot => {
  const endpoints: CompanionEndpoint[] = [];
  const seen = new Set<string>();
  for (const candidate of options.endpoints?.() ?? []) {
    if (endpoints.length >= MAX_COMPANION_ENDPOINTS) break;
    if (
      !candidate ||
      !COMPANION_ENDPOINT_KINDS.includes(candidate.kind) ||
      typeof candidate.url !== "string" ||
      !Number.isSafeInteger(candidate.priority) ||
      candidate.priority < 0 ||
      candidate.priority > 10_000 ||
      Buffer.byteLength(candidate.url) > 2_048
    ) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash
    ) {
      continue;
    }
    const url = parsed.origin;
    if (seen.has(url)) continue;
    seen.add(url);
    endpoints.push({
      kind: candidate.kind,
      priority: candidate.priority,
      url,
    });
  }
  return {
    serverName: [...options.serverName()].slice(0, 200).join(""),
    endpoints,
  };
};

/** Headers worth carrying to the harness. An allowlist rather than a
 * blocklist: `host` and `origin` must not travel (see above), `authorization`
 * is the sidecar's credential and means nothing to the harness, and hop-by-hop
 * headers are by definition not ours to relay. */
const forwardHeaders = (req: IncomingMessage, opts?: { passAuthorization?: boolean }): Record<string, string> => {
  const out: Record<string, string> = {
    accept: String(req.headers.accept ?? "*/*"),
    // Lets a response whose URL is intentionally loopback-only (the VPS SSH
    // viewer) fail before opening a tunnel a phone cannot reach. This header
    // carries no authority; it only narrows behavior at the harness.
    "x-openmausbot-companion": "1",
  };
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  // Bridge daemons authenticate to the harness with their own bearer token.
  // Device pairing tokens must not be substituted — forward only for /api/bridge/*.
  if (opts?.passAuthorization && req.headers.authorization) {
    out.authorization = String(req.headers.authorization);
  }
  // Last-Event-ID is how a reconnecting client asks for the gap. Dropping it
  // would turn every resume into a full re-hydration, silently.
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) out["last-event-id"] = String(lastEventId);
  return out;
};

/** The device-facing handler: refuse a browser, check the allowlist, check
 * the token, then replay the request to the harness over loopback and scrub
 * what comes back. Pairing is the one route that stops here. */
export function createProxyHandler(options: ProxyOptions) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const fullUrl = req.url ?? "/";
    const path = fullUrl.split("?")[0];
    const method = req.method ?? "GET";

    // A native app sends no Origin. Anything that does is a browser that has
    // found this port, and a browser has no business on it — refused before
    // the token is even looked at, and regardless of what the origin says.
    if (req.headers.origin) {
      return sendJson(res, 403, { error: "forbidden: cross-origin request" });
    }

    const token = bearerToken(req.headers.authorization);
    let device = options.authenticate(token);
    if (!device) {
      const botId = localVmViewerBotId(path);
      if (botId && (isLocalVmViewer(method, path) || isLocalVmViewerUpgrade(path))) {
        const deviceId = resolveViewerAccessDeviceId(fullUrl, req.headers.cookie, botId);
        if (deviceId) device = options.deviceById?.(deviceId) ?? null;
      }
    }
    const denial = denyReason({
      path,
      method,
      // `bearerToken` is the registry's own parser, imported rather than
      // reimplemented: this file used to have a second one, and two parsers
      // that disagree about what a credential looks like means the header a
      // phone sends authenticates on one code path and not the other.
      authenticated: Boolean(device),
    });
    if (denial) return sendJson(res, denial.status, { error: denial.error });

    // Pairing a phone grants the ordinary companion surface, not a browser
    // session with every credential that may exist inside the cloud desktop.
    // The computer owner enables this capability per device, off by default.
    if (isCloudDesktopJoin(method, path) && !device?.cloudDesktopAccess) {
      return sendJson(res, 403, {
        error: "cloud desktop access is off for this phone — enable it in OpenMausBot → Settings → Phone",
      });
    }

    if (isLocalVmPhoneSurface(method, path) && !device?.localVmAccess) {
      return sendJson(res, 403, {
        error: "Local VM access is off for this phone — enable it in OpenMausBot → Settings → Companion",
      });
    }

    // Pairing terminates here. Forwarding it would hand the harness a route
    // it does not have, and the 404 would read to a phone as "wrong address".
    if (method === "POST" && path === "/api/pair") {
      readJson(req, 64 * 1024, true).then(
        (body) => {
          // New clients redeem the high-entropy credential carried by the QR.
          // `code` remains accepted for manual entry and older mobile builds.
          const result = options.redeem(
            String(body.credential ?? body.code ?? ""),
            body.deviceName,
            body.pairRequestId,
          );
          if ("error" in result) return sendJson(res, 401, { error: result.error });
          // `hosts` rides along whichever way the phone paired — QR, typed
          // address, or discovery — so every paired device learns the full
          // fallback list, not just the ones that scanned a QR. Absent, not
          // empty, when there is nothing to offer: absent is what a sidecar
          // predating the field sends, and one decode path beats two.
          const hosts = options.hosts?.() ?? [];
          const endpoints = options.endpoints?.() ?? [];
          const response: typeof result & {
            serverName: string;
            hosts?: string[];
            endpoints?: CompanionEndpoint[];
          } = {
            ...result,
            serverName: options.serverName(),
          };
          if (hosts.length) response.hosts = hosts;
          if (endpoints.length) response.endpoints = endpoints;
          return sendJson(res, 201, response);
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    // A paired phone refreshes connection candidates here after setup. This
    // is sidecar-owned state, so answer locally after the shared bearer and
    // default-deny checks above and never send it to the harness.
    if (method === "GET" && path === "/api/companion/endpoints") {
      return sendJson(res, 200, endpointSnapshot(options));
    }

    // Connector-card mutations are the one JSON body this proxy validates
    // before opening the harness request. A strict body shape keeps a paired
    // token from smuggling aliases, credentials, or future config fields.
    if (isConnectorCardAction(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "connector card requests require application/json" });
      }
      readJson(req).then(
        (body) => {
          const bodyDenial = validateConnectorCardBody(method, path, body);
          if (bodyDenial) return sendJson(res, bodyDenial.status, { error: bodyDenial.error });
          forward(Buffer.from(JSON.stringify(body), "utf8"));
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    // Status is read-only, but its thread scope still must be a single safe
    // query value. `denyReason` receives only the path by design, so inspect
    // this one query at the forwarding boundary.
    if (isConnectorCardStatus(method, path)) {
      let parsed: URL;
      try {
        parsed = new URL(req.url ?? path, "http://companion.invalid");
      } catch {
        return sendJson(res, 400, { error: "connector card status requires a valid threadId" });
      }
      const keys = [...parsed.searchParams.keys()];
      const threadId = parsed.searchParams.get("threadId");
      const queryDenial = keys.length === 1 ? validateConnectorCardThreadId(threadId) : {
        status: 400,
        error: "connector card status accepts only threadId",
      };
      if (queryDenial) return sendJson(res, queryDenial.status, { error: queryDenial.error });
      forward();
      return;
    }

    // Local VM actions and the read-only desktop capture carry no
    // caller-controlled fields. Buffer the tiny body here, validate the
    // exact empty object, then replay that object to the harness. Status is
    // read-only and can pass through normally.
    if (isLocalVmAction(method, path) || isLocalVmScreenshot(method, path) || isLocalVmJoin(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "Local VM actions require application/json" });
      }
      readJson(req, 64 * 1024, true).then(
        (body) => {
          const bodyDenial = validateLocalVmActionBody(method, path, body);
          if (bodyDenial) return sendJson(res, bodyDenial.status, { error: bodyDenial.error });
          forward(Buffer.from("{}", "utf8"));
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    if (isLocalVmInput(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "Local VM input requires application/json" });
      }
      readJson(req, 64 * 1024, true).then(
        (body) => {
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return sendJson(res, 400, { error: "input requires a JSON object" });
          }
          forward(Buffer.from(JSON.stringify(body), "utf8"));
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    if (isLocalVmViewer(method, path)) {
      forward(undefined, { path: stripViewerAccessQuery(fullUrl) });
      return;
    }

    if (isBotModel(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "model requires application/json" });
      }
      const botId = botModelBotId(path);
      if (!botId) return sendJson(res, 404, { error: `no route: ${method} ${path}` });
      readJson(req, 64 * 1024, true).then(
        (body) => {
          const parsed = validateBotModelBody(method, path, body);
          if ("denial" in parsed) return sendJson(res, parsed.denial.status, { error: parsed.denial.error });
          if (parsed.rewrite) {
            const selection: Record<string, unknown> = {
              instanceId: parsed.patch.instanceId,
              model: parsed.patch.model,
            };
            if (parsed.patch.effort != null) selection.effort = parsed.patch.effort;
            forward(Buffer.from(JSON.stringify({ modelSelection: selection }), "utf8"), {
              path: `/api/bots/${botId}`,
            });
            return;
          }
          forward(Buffer.from(JSON.stringify({
            instanceId: parsed.patch.instanceId,
            model: parsed.patch.model,
          }), "utf8"));
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    if (isComputerDestination(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "computer destination requires application/json" });
      }
      const botId = computerDestinationBotId(path);
      if (!botId) return sendJson(res, 404, { error: `no route: ${method} ${path}` });
      readJson(req, 64 * 1024, true).then(
        (body) => {
          const parsed = validateComputerDestinationBody(method, path, body);
          if ("denial" in parsed) return sendJson(res, parsed.denial.status, { error: parsed.denial.error });
          if (parsed.patch.computer === "vm" && device?.id) {
            options.grantLocalVmAccess?.(device.id);
          }
          forward(Buffer.from(JSON.stringify(parsed.patch), "utf8"), { path: `/api/bots/${botId}` });
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    if (isGroupSetup(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "group setup requires application/json" });
      }
      const roomId = groupSetupRoomId(path);
      if (!roomId) return sendJson(res, 404, { error: `no route: ${method} ${path}` });
      readJson(req, 64 * 1024, true).then(
        (body) => {
          const parsed = validateGroupSetupBody(method, path, body);
          if ("denial" in parsed) return sendJson(res, parsed.denial.status, { error: parsed.denial.error });
          forward(Buffer.from(JSON.stringify(parsed.patch), "utf8"), { path: `/api/groups/${roomId}` });
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    if (isBotVisibility(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "visibility requires application/json" });
      }
      const botId = botVisibilityBotId(path);
      if (!botId) return sendJson(res, 404, { error: `no route: ${method} ${path}` });
      readJson(req, 64 * 1024, true).then(
        (body) => {
          const parsed = validateBotVisibilityBody(method, path, body);
          if ("denial" in parsed) return sendJson(res, parsed.denial.status, { error: parsed.denial.error });
          forward(Buffer.from(JSON.stringify(parsed.patch), "utf8"), { path: `/api/bots/${botId}` });
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    if (isBotUnread(method, path) || isGroupUnread(method, path)) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendJson(res, 415, { error: "unread requires application/json" });
      }
      readJson(req, 64 * 1024, true).then(
        (body) => {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
            return sendJson(res, 400, { error: "unread accepts an empty JSON object only" });
          }
          const botId = botUnreadBotId(path);
          if (botId) {
            forward(Buffer.from(JSON.stringify({ unread: true }), "utf8"), { path: `/api/bots/${botId}`, method: "PATCH" });
            return;
          }
          const roomId = groupUnreadRoomId(path);
          if (roomId) {
            forward(Buffer.from(JSON.stringify({ unread: true }), "utf8"), { path: `/api/groups/${roomId}`, method: "PATCH" });
            return;
          }
          sendJson(res, 404, { error: `no route: ${method} ${path}` });
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    forward();

    function forward(requestBody?: Buffer, rewrite?: { path?: string; method?: string }): void {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.harnessPort,
        path: rewrite?.path ?? req.url,
        method: rewrite?.method ?? method,
        headers: forwardHeaders(req, { passAuthorization: path.startsWith("/api/bridge/") }),
      },
      (harness) => {
        clearTimeout(headersDeadline);
        // Keep liveness tied to the actual harness. Answering from the
        // sidecar alone made a dead bot server look healthy and caused the
        // desktop to advertise a hosted route that could not serve chats.
        // The harness response is inspected under a tiny bound, then replaced
        // completely so its pid/static fields never cross the public tunnel.
        if (method === "GET" && path === "/api/health") {
          const chunks: Buffer[] = [];
          let size = 0;
          let finished = false;
          const fail = () => {
            if (finished) return;
            finished = true;
            sendJson(res, 502, { error: "OpenMausBot is not ready on this computer" });
          };
          harness.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 4_096) {
              harness.destroy();
              fail();
              return;
            }
            chunks.push(chunk);
          });
          harness.on("error", fail);
          harness.on("end", () => {
            if (finished) return;
            let identity: unknown;
            try {
              identity = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              fail();
              return;
            }
            // SAFETY: identity came from untrusted JSON, and this assertion
            // grants no domain behavior; it permits one optional property
            // read whose value must equal a fixed literal before success.
            if (
              (harness.statusCode ?? 500) < 200 ||
              (harness.statusCode ?? 500) >= 300 ||
              (identity as { app?: unknown } | null)?.app !== "openmausbot"
            ) {
              fail();
              return;
            }
            finished = true;
            sendJson(res, 200, { app: "openmausbot" });
          });
          return;
        }

        const contentType = harness.headers["content-type"];
        const isStream = String(contentType ?? "").includes("text/event-stream");

        if (isStream) {
          const streamStatus = harness.statusCode ?? 500;
          const tracksDeviceConnection = method === "GET"
            && path === "/api/events"
            && streamStatus >= 200
            && streamStatus < 300
            && Boolean(device?.id);
          const currentDevice = tracksDeviceConnection ? options.authenticate(token) : device;
          if (tracksDeviceConnection && currentDevice?.id !== device?.id) {
            harness.destroy();
            return sendJson(res, 401, {
              error: "pair this device from Phone settings in OpenMausBot on your computer",
            });
          }
          const disconnect = () => {
            if (!harness.destroyed) harness.destroy();
            if (!res.destroyed) res.destroy();
          };
          let releaseConnection =
            tracksDeviceConnection && currentDevice?.id
              ? options.connected?.(currentDevice.id, disconnect) ?? null
              : null;
          const release = () => {
            releaseConnection?.();
            releaseConnection = null;
          };
          // Headers first and flushed, or nothing downstream believes the
          // connection is live. content-length is meaningless here and
          // content-encoding would be a lie once we rewrite the bytes.
          res.writeHead(harness.statusCode ?? 200, {
            "content-type": "text/event-stream",
            ...PRIVATE_RESPONSE_HEADERS,
            "cache-control": "private, no-store, no-transform",
            connection: "keep-alive",
            // Nagle would hold a small frame back waiting for company. On a
            // stream whose frames are small and whose whole value is being
            // timely, that is exactly wrong.
            "x-accel-buffering": "no",
          });
          res.flushHeaders?.();
          res.socket?.setNoDelay(true);
          // The harness writes an SSE keepalive every 25 seconds. TCP
          // keepalive covers the other direction so a vanished phone cannot
          // leave the desktop indicator green indefinitely on a half-open
          // connection.
          res.socket?.setKeepAlive(true, 30_000);

          const scrubStream = createSseScrubber();
          harness.setEncoding("utf8");
          harness.on("data", (chunk: string) => {
            let rewritten: string;
            try {
              rewritten = scrubStream(chunk);
            } catch {
              // The buffer ceiling. Half an event cannot be forwarded safely,
              // so the stream ends here rather than growing without bound.
              release();
              harness.destroy();
              res.end();
              return;
            }
            if (!rewritten) return;
            // A phone on a slow link reads slower than the harness writes,
            // and the difference has to go somewhere. Ignoring what write()
            // returns puts it in this process's memory, unbounded, for as
            // long as the phone stays connected and behind. Pausing pushes it
            // back to the harness, which is where the backlog belongs.
            if (!res.write(rewritten)) harness.pause();
          });
          res.on("drain", () => harness.resume());
          harness.on("end", () => {
            release();
            res.end();
          });
          harness.on("error", () => {
            release();
            res.destroy();
          });
          // A device that hangs up must take the upstream connection with
          // it, or the harness accumulates readers nobody is listening to.
          res.on("close", () => {
            release();
            harness.destroy();
          });
          return;
        }

        const encoding = String(harness.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        if (!isJson(String(contentType ?? "")) || (encoding && encoding !== "identity")) {
          // images and anything else: byte-for-byte, no parsing.
          //
          // Encoded bodies come through here too. Scrubbing one would mean
          // decompressing it, and the alternative the buffering branch would
          // otherwise reach — decode as UTF-8, re-serialise, drop the
          // content-encoding header — corrupts it silently. `forwardHeaders`
          // never sends accept-encoding, so this is a guard rather than a
          // path: if it ever fires, the body passes through unscrubbed and
          // intact rather than scrubbed and broken.
          const passthroughHeaders = privateHeaders(harness.headers);
          const viewerBotId = localVmViewerBotId(path);
          const viewerCookie = viewerBotId
            ? viewerAccessSetCookieForRequest(
              fullUrl,
              method,
              path,
              viewerBotId,
              harness.statusCode ?? 200,
            )
            : null;
          if (viewerCookie) passthroughHeaders["set-cookie"] = [viewerCookie];
          res.writeHead(harness.statusCode ?? 200, passthroughHeaders);
          // `pipe` does not carry a failure from source to destination. An
          // upstream that dies part-way through an image would otherwise
          // leave the phone holding an open connection and a content-length
          // that will never be satisfied — it waits for the rest forever,
          // which reads as a frozen app rather than as a failed request.
          harness.on("error", () => res.destroy());
          harness.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        harness.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_BODY_BYTES) {
            harness.destroy();
            if (res.headersSent) res.destroy();
            else sendJson(res, 502, { error: "the response from OpenMausBot was too large" });
            return;
          }
          chunks.push(chunk);
        });
        harness.on("error", () => res.destroy());
        harness.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          // Two failures live here and they are not the same failure.
          //
          // A body that does not parse was never JSON — the content-type
          // lied, or the harness sent an empty 204. There is nothing to
          // redact in bytes that do not read as an object, so forwarding
          // them verbatim is correct.
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            forward(body, harness.headers, harness.statusCode ?? 200);
            return;
          }

          // A body that parses but will not scrub is the opposite case. We
          // know it is structured, and `scrub` is the only thing keeping the
          // harness's internal fields — the resume cursors — off the wire to
          // a device. Falling back to the raw body there, which is what one
          // try around parse-and-scrub used to do, sends exactly what the
          // scrubber exists to withhold. Not hypothetical: `scrub` recurses,
          // so a body nested a few thousand deep throws RangeError where
          // JSON.parse handles it fine.
          let text: string;
          try {
            if (
              isLocalVmJoin(method, path)
              && device?.id
              && parsed
              && typeof parsed === "object"
            ) {
              const record = parsed as Record<string, unknown>;
              const botId = /^\/api\/bots\/([\w-]+)\/local-computer\/join$/.exec(path)?.[1];
              if (botId && typeof record.viewerPath === "string") {
                const viewerTicket = mintViewerAccessToken(device.id, botId);
                record.viewerPath = appendViewerAccessQuery(record.viewerPath, viewerTicket);
              }
            }
            text = JSON.stringify(scrub(parsed));
          } catch {
            sendJson(res, 502, { error: "the response could not be prepared for this device" });
            return;
          }
          forward(text, harness.headers, harness.statusCode ?? 200);
        });

        /** Re-frame and send. The body was re-serialised, so nothing the
         * harness said about its framing survives. `transfer-encoding`
         * matters most: leaving it alongside the content-length set here is
         * a protocol violation, and Node's own parser rejects the response
         * outright rather than tolerating it. */
        function forward(text: string, upstreamHeaders: IncomingMessage["headers"], status: number): void {
          const headers = { ...upstreamHeaders };
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          res.writeHead(status, {
            ...privateHeaders(headers),
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
        }
      },
    );

    // A phone can go away at any point: before the harness has answered,
    // while its own request body is still going up, or partway through a
    // large response. Every one of those leaves the harness producing for
    // nobody unless the upstream goes with it. Guarded on `writableEnded` so
    // an ordinary finished response does not tear down a keep-alive socket
    // on its way out.
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());

    // `http.request` has no deadline of its own for the headers phase: a
    // harness that accepts the connection and then says nothing holds the
    // device's request open until one side gives up, which neither does.
    let timedOut = false;
    const headersDeadline = setTimeout(() => {
      timedOut = true;
      upstream.destroy(new Error("the harness sent no response headers"));
    }, options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS);
    headersDeadline.unref?.();

    upstream.on("error", () => {
      clearTimeout(headersDeadline);
      // Headers already went out — a stream, or a piped body — or the
      // response is finished and this is a socket dying afterwards. There is
      // no status code left to send in either case, and writeHead here throws
      // ERR_HTTP_HEADERS_SENT out of an event handler with nothing to catch
      // it, taking the whole sidecar down over one dead connection. Dropping
      // the socket is the only honest signal, and one a client recovers from.
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      sendJson(
        res,
        timedOut ? 504 : 502,
        timedOut
          ? { error: "OpenMausBot did not respond" }
          : { error: "OpenMausBot is not running on this computer" },
      );
    });
    if (requestBody) upstream.end(requestBody);
    else req.pipe(upstream);
    }
  };
}
