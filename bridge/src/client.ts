import type { BridgeCredentials, BridgeJob } from "./types.ts";

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export async function registerBridge(input: {
  url: string;
  name: string;
  code: string;
  capabilities?: string[];
  hostInfo?: string;
}): Promise<BridgeCredentials> {
  const res = await fetch(`${normalizeUrl(input.url)}/api/bridge/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      code: input.code,
      capabilities: input.capabilities ?? ["shell"],
      hostInfo: input.hostInfo,
    }),
  });
  const body = (await res.json()) as { bridgeId?: string; bridgeToken?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `register failed (${res.status})`);
  if (!body.bridgeId || !body.bridgeToken) throw new Error("register response missing credentials");
  return {
    url: normalizeUrl(input.url),
    bridgeId: body.bridgeId,
    bridgeToken: body.bridgeToken,
    name: input.name,
  };
}

export async function heartbeat(
  credentials: BridgeCredentials,
  hostInfo?: string,
  capabilities?: string[],
): Promise<BridgeJob[]> {
  const res = await fetch(`${credentials.url}/api/bridge/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ bridgeId: credentials.bridgeId, hostInfo, capabilities }),
  });
  const body = (await res.json()) as { jobs?: BridgeJob[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `heartbeat failed (${res.status})`);
  return body.jobs ?? [];
}

export async function submitResult(
  credentials: BridgeCredentials,
  jobId: string,
  result: { exitCode: number; stdout: string; stderr: string },
): Promise<void> {
  const res = await fetch(`${credentials.url}/api/bridge/result`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jobId, ...result }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `result failed (${res.status})`);
  }
}
