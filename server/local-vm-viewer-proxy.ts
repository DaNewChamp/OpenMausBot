// Loopback noVNC proxy for paired phones.
//
// The viewer stays on 127.0.0.1 inside the container host. Phones reach it
// only through /api/bots/:id/local-computer/viewer/* on the harness, then
// through the companion's matching allowlist and WebSocket forward.
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import type { ContainerComputerStatus } from "./container-computer.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface LocalVmViewerTarget {
  port: number;
  password: string | null;
}

export interface LocalVmViewerJoin {
  viewerPath: string;
  ready: true;
}

const VIEWER_PREFIX = /^\/api\/bots\/([\w-]+)\/local-computer\/viewer(\/.*)?$/;

export function parseLocalVmViewerRoute(path: string): { botId: string; subpath: string } | null {
  const match = VIEWER_PREFIX.exec(path.split("?")[0] ?? "");
  if (!match) return null;
  const subpath = match[2] || "/";
  return { botId: match[1], subpath: subpath.startsWith("/") ? subpath : `/${subpath}` };
}

function viewerPasswordFromUrl(viewerUrl: string): string | null {
  const hash = viewerUrl.includes("#") ? viewerUrl.slice(viewerUrl.indexOf("#") + 1) : "";
  if (!hash) return null;
  const password = new URLSearchParams(hash).get("password");
  return password || null;
}

export function localVmViewerTarget(status: ContainerComputerStatus): LocalVmViewerTarget | null {
  if (!status.ready || !status.viewer_port) return null;
  return {
    port: status.viewer_port,
    password: viewerPasswordFromUrl(status.viewer_url),
  };
}

export function localVmViewerJoinPath(botId: string, target: LocalVmViewerTarget): LocalVmViewerJoin {
  const params = new URLSearchParams({ autoconnect: "true", resize: "scale" });
  if (target.password) params.set("password", target.password);
  // Loopback websockify listens at `/` on the viewer port. Through the harness
  // proxy the phone must open ws://<companion>/api/bots/:id/local-computer/viewer
  // — not ws://…/websockify, which 404s and leaves noVNC spinning forever.
  params.set("path", `api/bots/${botId}/local-computer/viewer`);
  return {
    viewerPath: `/api/bots/${botId}/local-computer/viewer/vnc.html#${params.toString()}`,
    ready: true,
  };
}

function endToEndHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const blocked = new Set(HOP_BY_HOP);
  const connection = Array.isArray(headers.connection)
    ? headers.connection.join(",")
    : String(headers.connection ?? "");
  for (const name of connection.split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] =>
        entry[1] !== undefined && !blocked.has(entry[0].toLowerCase()),
    ),
  );
}

/** WebSocket upgrades must keep the handshake headers end-to-end. The generic
 * hop-by-hop filter treats `Connection: Upgrade` as a signal to drop
 * `upgrade`, which turns a proxied handshake into a plain GET and leaves
 * noVNC on `noVNC_loading` forever. */
export function upgradeHopByHopHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string | string[]] => {
        if (entry[1] === undefined) return false;
        const lower = entry[0].toLowerCase();
        if (lower === "upgrade" || lower === "connection") return true;
        if (lower.startsWith("sec-websocket-")) return true;
        return !HOP_BY_HOP.has(lower);
      },
    ),
  );
}

export function proxyLocalVmViewerHttp(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
  target: LocalVmViewerTarget,
  subpath: string,
): void {
  const query = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
  const upstreamPath = `${subpath}${query}`;
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: target.port,
      path: upstreamPath,
      method: req.method,
      headers: {
        ...endToEndHeaders(req.headers),
        host: `127.0.0.1:${target.port}`,
      },
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "The Local VM viewer is unavailable." }));
      return;
    }
    res.destroy();
  });
  req.pipe(upstream);
}

export function proxyLocalVmViewerUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  target: LocalVmViewerTarget,
  subpath: string,
): void {
  const query = (req.url ?? "").includes("?") ? (req.url ?? "").slice((req.url ?? "").indexOf("?")) : "";
  const upstreamPath = `${subpath}${query}`;
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: target.port,
    path: upstreamPath,
    method: req.method,
    headers: {
      ...upgradeHopByHopHeaders(req.headers),
      host: `127.0.0.1:${target.port}`,
    },
  });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const headers = upgradeHopByHopHeaders(response.headers);
    let raw = `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`;
    for (const [name, value] of Object.entries(headers)) {
      raw += `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
    }
    raw += "\r\n";
    clientSocket.write(raw);
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    const destroyBoth = () => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on("error", destroyBoth);
    clientSocket.on("error", destroyBoth);
    upstreamSocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstreamSocket.destroy());
  });
  upstream.on("response", (response) => {
    if (response.statusCode === 101) return;
    clientSocket.write(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\n\r\n`);
    response.pipe(clientSocket);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => {
    upstream.destroy();
  });
  upstream.end();
}
