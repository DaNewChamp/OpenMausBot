import http from "node:http";
import { describe, expect, it } from "vitest";
import { createPinnedBrowserProxy } from "./browser-network-proxy.cjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

describe("pinned browser network proxy", () => {
  it("connects to the resolver's literal address and refuses private answers", async () => {
    const target = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned");
    });
    const targetPort = await listen(target);
    const proxy = createPinnedBrowserProxy({
      session: {},
      resolveHost: (_session, hostname) => Promise.resolve({
        endpoints: [{ address: hostname === "public.example" ? "127.0.0.1" : "10.0.0.1" }],
      }),
      // The production predicate rejects loopback; this test seam permits it
      // only as the local upstream fixture to prove literal-address dialing.
      addressAllowed: (address) => address === "127.0.0.1",
    });
    const { port: proxyPort } = await proxy.start();
    const request = (host) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, path: `http://${host}:${targetPort}/`, headers: { host: `${host}:${targetPort}` } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    await expect(request("public.example")).resolves.toEqual({ status: 200, body: "pinned" });
    await expect(request("private.example")).resolves.toMatchObject({ status: 403 });
    proxy.close();
    await close(target);
  });
});
