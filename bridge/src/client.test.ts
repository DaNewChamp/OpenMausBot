import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLocalVmInvoke } from "./client.ts";
import type { BridgeCredentials, BridgeJob } from "./types.ts";

const credentials: BridgeCredentials = {
  url: "https://hub.example.test", bridgeId: "bridge-a", bridgeToken: "fixture-only-token", name: "fixture",
};
const job: BridgeJob = {
  id: "job-a", bridgeId: "bridge-a", generation: 4, createdAt: 0, timeoutMs: 1000,
  kind: "local-vm-invoke", payload: { botId: "shared", threadId: "thread-a", tool: "screenshot", arguments: {} },
};
afterEach(() => vi.unstubAllGlobals());

describe("native bridge command authorization", () => {
  it("authenticates the exact job delivery generation over the daemon-only endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await authorizeLocalVmInvoke(credentials, job);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/api/bridge/local-vm/authorize");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({ authorization: "Bearer fixture-only-token" });
    expect(JSON.parse(String(request.body))).toEqual({ jobId: "job-a", generation: 4 });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403, 409, 503])("fails closed on HTTP %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not executable" }), { status })));
    await expect(authorizeLocalVmInvoke(credentials, job)).rejects.toThrow("not executable");
  });

  it("does not accept a successful response without explicit permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await expect(authorizeLocalVmInvoke(credentials, job)).rejects.toThrow("authorization refused");
  });
});
