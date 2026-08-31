// A loopback HTTP CONNECT proxy for the built-in browser.
//
// Chromium's onBeforeRequest hook can inspect a hostname, but it cannot pin
// the socket Chromium opens after that callback returns. This proxy is the
// network boundary instead: it resolves a name once, refuses non-public
// answers, and connects to the returned address (never the name) for every
// request. HTTPS remains end-to-end because CONNECT carries the browser's TLS
// handshake, including the original hostname/SNI.
"use strict";

const http = require("node:http");
const net = require("node:net");
const { URL } = require("node:url");

const CONNECT_TIMEOUT_MS = 10_000;
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

function authorityFromConnect(raw) {
  const text = String(raw ?? "").trim();
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^:]+):(\d{1,5})$/.exec(text);
  if (!match) throw new Error("invalid proxy destination");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid proxy destination port");
  const hostname = match[1].replace(/^\[|\]$/g, "");
  if (!hostname) throw new Error("invalid proxy destination host");
  return { hostname, port };
}

function requestUrl(raw, host) {
  const text = String(raw ?? "");
  let parsed;
  try {
    parsed = new URL(text, `http://${String(host ?? "")}`);
  } catch {
    throw new Error("invalid proxy request");
  }
  if (parsed.protocol !== "http:") throw new Error("only HTTP proxy requests are supported");
  if (parsed.username || parsed.password) throw new Error("proxy credentials are not allowed");
  if (!parsed.hostname) throw new Error("invalid proxy destination host");
  return parsed;
}

function forwardedHeaders(headers, host, upgrade = false) {
  const out = {};
  const connection = Array.isArray(headers.connection) ? headers.connection.join(",") : String(headers.connection ?? "");
  const blocked = new Set(HOP_BY_HOP);
  for (const name of connection.split(",")) if (name.trim()) blocked.add(name.trim().toLowerCase());
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || blocked.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out.host = host;
  if (upgrade) {
    out.connection = headers.connection ?? "Upgrade";
    out.upgrade = headers.upgrade ?? "websocket";
  } else {
    out.connection = "close";
  }
  return out;
}

function rejectResponse(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "connection": "close" });
  response.end(message);
}

/**
 * @param {object} options
 * @param {object} options.session Electron session passed to resolveHost
 * @param {(session: object, hostname: string) => Promise<{endpoints?: Array<{address?: string}>}>} options.resolveHost
 * @param {(address: string) => boolean} options.addressAllowed
 */
function createPinnedBrowserProxy({ session, resolveHost, addressAllowed }) {
  if (!session || resolveHost?.constructor !== Function || addressAllowed?.constructor !== Function) {
    throw new Error("a browser proxy session and resolver are required");
  }
  const server = http.createServer();
  let address = null;
  let listening = false;
  let closed = false;

  const resolveAddress = async (hostname) => {
    const resolved = await resolveHost(session, hostname);
    const endpoints = Array.isArray(resolved?.endpoints) ? resolved.endpoints : [];
    const addresses = endpoints.map((endpoint) => String(endpoint?.address ?? "")).filter(Boolean);
    if (!addresses.length || !addresses.every((candidate) => addressAllowed(candidate))) {
      throw new Error("local and private-network destinations are blocked");
    }
    // Connecting to this literal address is the pin. Do not hand the
    // hostname back to net/http, which would perform a second DNS lookup.
    return addresses[0];
  };

  const connect = (host, port) => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, family: host.includes(":") ? 6 : 4 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy destination timed out"));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const handleConnect = async (request, client, head) => {
    try {
      const { hostname, port } = authorityFromConnect(request.url);
      const target = await resolveAddress(hostname);
      const upstream = await connect(target, port);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      const closeBoth = () => {
        upstream.destroy();
        client.destroy();
      };
      upstream.once("error", closeBoth);
      client.once("error", closeBoth);
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    } catch (error) {
      client.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      client.destroy();
    }
  };

  const handleRequest = async (request, response) => {
    let parsed;
    try {
      parsed = requestUrl(request.url, request.headers.host);
      const target = await resolveAddress(parsed.hostname);
      const upstream = http.request({
        hostname: target,
        family: target.includes(":") ? 6 : 4,
        port: Number(parsed.port || 80),
        path: `${parsed.pathname || "/"}${parsed.search}`,
        method: request.method,
        headers: forwardedHeaders(request.headers, parsed.host),
        agent: false,
      }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      });
      request.once("aborted", () => upstream.destroy());
      response.once("close", () => upstream.destroy());
      upstream.once("error", () => rejectResponse(response, 502, "browser destination unavailable"));
      request.pipe(upstream);
    } catch (error) {
      rejectResponse(response, 403, error?.message || "browser destination blocked");
    }
  };

  const handleUpgrade = async (request, socket, head) => {
    try {
      const parsed = requestUrl(request.url, request.headers.host);
      const target = await resolveAddress(parsed.hostname);
      const upstream = http.request({
        hostname: target,
        family: target.includes(":") ? 6 : 4,
        port: Number(parsed.port || 80),
        path: `${parsed.pathname || "/"}${parsed.search}`,
        method: request.method,
        headers: forwardedHeaders(request.headers, parsed.host, true),
        agent: false,
      });
      upstream.once("upgrade", (incoming, upstreamSocket, upstreamHead) => {
        let raw = `HTTP/1.1 ${incoming.statusCode ?? 101} ${incoming.statusMessage ?? "Switching Protocols"}\r\n`;
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          raw += `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
        }
        raw += "\r\n";
        socket.write(raw);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        const closeBoth = () => {
          upstreamSocket.destroy();
          socket.destroy();
        };
        upstreamSocket.once("error", closeBoth);
        socket.once("error", closeBoth);
        upstreamSocket.once("close", () => socket.destroy());
        socket.once("close", () => upstreamSocket.destroy());
      });
      upstream.once("response", (incoming) => {
        socket.write(`HTTP/1.1 ${incoming.statusCode ?? 502} ${incoming.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
        incoming.pipe(socket);
      });
      upstream.once("error", () => socket.destroy());
      socket.once("error", () => upstream.destroy());
      upstream.end();
    } catch {
      socket.destroy();
    }
  };

  server.on("request", (request, response) => {
    if (!closed) void handleRequest(request, response);
    else rejectResponse(response, 503, "browser proxy unavailable");
  });
  server.on("connect", (request, socket, head) => {
    if (!closed) void handleConnect(request, socket, head);
    else socket.destroy();
  });
  server.on("upgrade", (request, socket, head) => {
    if (!closed) void handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  return {
    start() {
      if (listening) return Promise.resolve(address);
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          address = server.address();
          listening = true;
          resolve(address);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      });
    },
    close() {
      closed = true;
      if (!listening) return;
      server.closeAllConnections?.();
      server.close();
      listening = false;
    },
    resolveAddress,
  };
}

module.exports = { authorityFromConnect, createPinnedBrowserProxy, forwardedHeaders, requestUrl };
