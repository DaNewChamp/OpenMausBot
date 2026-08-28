// Loopback noVNC proxy for paired phones. The viewer port and password never
// leave the Mac except as a relative join URL whose fragment stays client-side.
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import net from "node:net";

import {
  containerComputerStatus,
  type LocalVmTarget,
} from "./container-computer.ts";

export function parseLocalVmViewerPath(path: string): { botId: string; suffix: string } | null {
  const match = /^\/api\/bots\/([\w-]+)\/local-computer\/viewer(\/.*)?$/.exec(path);
  if (!match) return null;
  return { botId: match[1], suffix: match[2] || "/vnc.html" };
}

export async function localVmViewerPort(target: LocalVmTarget): Promise<number | null> {
  const status = await containerComputerStatus(undefined, undefined, target);
  if (!status.ready || !status.viewer_port) return null;
  if (status.network !== "loopback") return null;
  return status.viewer_port;
}

export function localVmViewerJoinPath(botId: string, viewerUrl: string): string {
  const hashIndex = viewerUrl.indexOf("#");
  const fragment = hashIndex >= 0 ? viewerUrl.slice(hashIndex + 1) : "";
  const base = `/api/bots/${botId}/local-computer/viewer/vnc.html`;
  return fragment ? `${base}#${fragment}` : base;
}

export async function proxyLocalVmViewerHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: LocalVmTarget,
  suffix: string,
  search: string,
): Promise<boolean> {
  const port = await localVmViewerPort(target);
  if (!port) {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Local VM viewer is not ready" }));
    return true;
  }

  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  await new Promise<void>((resolve) => {
    const proxyReq = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: `${path}${search}`,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${port}`,
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", resolve);
        proxyRes.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
          resolve();
        });
      },
    );
    proxyReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("viewer proxy failed");
      resolve();
    });
    req.pipe(proxyReq);
  });
  return true;
}

export async function proxyLocalVmViewerUpgrade(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  target: LocalVmTarget,
  suffix: string,
  search: string,
): Promise<boolean> {
  const port = await localVmViewerPort(target);
  if (!port) {
    clientSocket.destroy();
    return true;
  }

  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  await new Promise<void>((resolve) => {
    const upstream = net.connect(port, "127.0.0.1", () => {
      const lines = [`${req.method} ${path}${search} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const entry of values) lines.push(`${key}: ${entry}`);
      }
      lines.push("", "");
      upstream.write(lines.join("\r\n"));
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => {
      clientSocket.destroy();
      resolve();
    });
    clientSocket.on("error", () => {
      upstream.destroy();
      resolve();
    });
    clientSocket.on("close", () => {
      upstream.destroy();
      resolve();
    });
  });
  return true;
}
