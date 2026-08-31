import type { IncomingMessage } from "node:http";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const SENSITIVE = new Set(["authorization", "cookie", "origin"]);

/** The sidecar consumes viewer credentials before proxying. Forward only the
 * WebSocket handshake fields required by the loopback noVNC target. */
export function viewerUpgradeHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const connection = Array.isArray(headers.connection) ? headers.connection.join(",") : String(headers.connection ?? "");
  const blocked = new Set(HOP_BY_HOP);
  for (const name of connection.split(",")) if (name.trim()) blocked.add(name.trim().toLowerCase());
  const forwarded: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (lower !== "upgrade" && lower !== "connection" && !lower.startsWith("sec-websocket-") && (blocked.has(lower) || SENSITIVE.has(lower))) continue;
    forwarded[name] = value;
  }
  return forwarded;
}
