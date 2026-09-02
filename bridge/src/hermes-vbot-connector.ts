import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";

export const HERMES_VBOT_MAX_PAYLOAD_BYTES = 64 * 1024;

export class HermesVbotConnectorError extends Error {
  readonly code: "loopback_required" | "peer_unauthenticated" | "payload_too_large" | "disconnected";

  constructor(code: HermesVbotConnectorError["code"], message: string) {
    super(message);
    this.name = "HermesVbotConnectorError";
    this.code = code;
  }
}

export type HermesVbotListen =
  | { socketPath: string }
  | { host: string; port: number };

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

type ConnectorHandler = (request: JsonRpcRequest) => Promise<JsonRpcSuccess>;

export type StartHermesVbotConnectorInput = {
  listen: HermesVbotListen;
  peerCredential: string;
  botScope: string;
  handler?: ConnectorHandler;
  log?: (line: string) => void;
};

export type HermesVbotConnectorServer = {
  address: { host?: string; port?: number; socketPath?: string };
  close: () => Promise<void>;
};

export type HermesVbotConnectorClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
  close: () => void;
};

export function daemonHermesVbotConnectorOptions(input: {
  bridgeId: string;
  bridgeToken?: string;
  socketPath: string;
  botScope: string;
}): StartHermesVbotConnectorInput {
  void input.bridgeToken;
  return {
    listen: { socketPath: input.socketPath },
    peerCredential: input.bridgeId,
    botScope: input.botScope,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function redact(line: string): string {
  return line
    .replace(/\b(?:token|secret|password|authorization)=[^\s]+/gi, (match) => `${match.split("=")[0]}=[redacted]`)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/HERMES_HOME(?:=[^\s]*)?/gi, "HERMES_HOME")
    .replace(/(?:\/[\w.-]+)+/g, "[path]");
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

function readFrames(socket: Socket, onFrame: (frame: unknown) => void, onOversize: () => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (buffer.length + chunk.length > HERMES_VBOT_MAX_PAYLOAD_BYTES) {
      onOversize();
      socket.destroy();
      return;
    }
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          onFrame(JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
      }
      if (buffer.length > HERMES_VBOT_MAX_PAYLOAD_BYTES) {
        onOversize();
        socket.destroy();
        return;
      }
      newline = buffer.indexOf("\n");
    }
  });
}

export async function startHermesVbotConnector(input: StartHermesVbotConnectorInput): Promise<HermesVbotConnectorServer> {
  if ("host" in input.listen && !isLoopbackHost(input.listen.host)) {
    throw new HermesVbotConnectorError("loopback_required", "Hermes connector must bind loopback only");
  }

  const log = (line: string) => input.log?.(redact(line));
  const server: Server = createServer((socket) => {
    let authed = false;
    readFrames(socket, (frame) => {
      if (!authed) {
        const hello = frame as { type?: string; peerCredential?: string; botScope?: string };
        if (hello?.type !== "hello" || hello.peerCredential !== input.peerCredential || hello.botScope !== input.botScope) {
          log("rejected unauthenticated peer");
          socket.write(`${JSON.stringify({ type: "error", error: { code: "peer_unauthenticated", message: "peer credential required" } })}\n`);
          socket.destroy();
          return;
        }
        authed = true;
        socket.write(`${JSON.stringify({ type: "hello-ok", botScope: input.botScope })}\n`);
        return;
      }
      const request = frame as JsonRpcRequest;
      if (!request || request.jsonrpc !== "2.0" || request.id === undefined || typeof request.method !== "string") {
        socket.destroy();
        return;
      }
      const payload = JSON.stringify(request);
      if (payload.length > HERMES_VBOT_MAX_PAYLOAD_BYTES) {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "payload_too_large", message: "payload too large" } })}\n`);
        socket.destroy();
        return;
      }
      void (input.handler?.(request) ?? Promise.resolve({ jsonrpc: "2.0" as const, id: request.id, result: null }))
        .then((response) => {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response.result })}\n`);
        })
        .catch(() => {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "internal", message: "request failed" } })}\n`);
        });
    }, () => {
      log("payload too large");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("socketPath" in input.listen) {
      try { unlinkSync(input.listen.socketPath); } catch { /* nothing to replace */ }
      server.listen(input.listen.socketPath, resolve);
    } else {
      server.listen(input.listen.port, input.listen.host, resolve);
    }
  });

  const address = server.address();
  return {
    address: "socketPath" in input.listen
      ? { socketPath: input.listen.socketPath }
      : { host: "127.0.0.1", port: typeof address === "object" && address ? address.port : input.listen.port },
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        if ("socketPath" in input.listen) {
          try { unlinkSync(input.listen.socketPath); } catch { /* already gone */ }
        }
        resolve();
      });
    }),
  };
}

export async function connectHermesVbotConnector(input: {
  socketPath?: string;
  host?: string;
  port?: number;
  peerCredential: string;
  botScope?: string;
}): Promise<HermesVbotConnectorClient> {
  if (!input.peerCredential) {
    throw new HermesVbotConnectorError("peer_unauthenticated", "peer credential required");
  }
  const socket = input.socketPath
    ? createConnection(input.socketPath)
    : createConnection({ host: input.host ?? "127.0.0.1", port: input.port ?? 0 });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", resolve);
  });
  const pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let helloResolve: (() => void) | undefined;
  let helloReject: ((error: Error) => void) | undefined;
  const helloReady = new Promise<void>((resolve, reject) => {
    helloResolve = resolve;
    helloReject = reject;
  });
  readFrames(socket, (frame) => {
    const record = frame as { type?: string; id?: string | number; result?: unknown; error?: { code?: string; message?: string } };
    if (record.type === "hello-ok") {
      helloResolve?.();
      return;
    }
    if (record.type === "error" && record.error?.code === "peer_unauthenticated") {
      helloReject?.(new HermesVbotConnectorError("peer_unauthenticated", "peer credential required"));
      return;
    }
    if (record.id === undefined) return;
    const waiter = pending.get(record.id);
    if (!waiter) return;
    pending.delete(record.id);
    if (record.error) {
      waiter.reject(new HermesVbotConnectorError(
        record.error.code === "payload_too_large" ? "payload_too_large" : "disconnected",
        record.error.message ?? "request failed",
      ));
      return;
    }
    waiter.resolve(record.result);
  }, () => {
    for (const waiter of pending.values()) {
      waiter.reject(new HermesVbotConnectorError("payload_too_large", "payload too large"));
    }
    pending.clear();
  });
  socket.write(`${JSON.stringify({ type: "hello", peerCredential: input.peerCredential, botScope: input.botScope ?? "bot-1" })}\n`);
  socket.on("close", () => {
    helloReject?.(new HermesVbotConnectorError("peer_unauthenticated", "peer credential required"));
    for (const waiter of pending.values()) {
      waiter.reject(new HermesVbotConnectorError("disconnected", "connector closed"));
    }
    pending.clear();
  });
  try {
    await helloReady;
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return {
    request(method, params) {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      if (payload.length > HERMES_VBOT_MAX_PAYLOAD_BYTES) {
        return Promise.reject(new HermesVbotConnectorError("payload_too_large", "payload too large"));
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.write(`${payload}\n`);
      });
    },
    close() {
      socket.end();
    },
  };
}
