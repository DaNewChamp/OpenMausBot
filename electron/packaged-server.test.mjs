import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { probeOwnedPackagedServer } from "./packaged-server.mjs";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function jsonHandler(status, body) {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

describe("packaged server health probe", () => {
  it("accepts only the child we forked", async () => {
    const { server, port } = await listen(
      jsonHandler(200, { app: "openmausbot", pid: 4242, static: true }),
    );
    try {
      await expect(probeOwnedPackagedServer({ port, pid: 4242 })).resolves.toMatchObject({
        status: "owned",
      });
      await expect(probeOwnedPackagedServer({ port, pid: 1 })).resolves.toEqual({
        status: "foreign",
        body: { app: "openmausbot", pid: 4242, static: true },
      });
    } finally {
      server.close();
    }
  });

  it("treats a hanging listener as unreachable instead of waiting forever", async () => {
    const { server, port } = await listen(() => {
      /* accept TCP, never write a response */
    });
    try {
      await expect(
        probeOwnedPackagedServer({ port, pid: 1, timeoutMs: 50 }),
      ).resolves.toEqual({ status: "unreachable" });
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("does not mistake an HTTP error for our child", async () => {
    const { server, port } = await listen(jsonHandler(503, { app: "openmausbot" }));
    try {
      await expect(probeOwnedPackagedServer({ port, pid: 1 })).resolves.toEqual({
        status: "not-ok",
      });
    } finally {
      server.close();
    }
  });
});
