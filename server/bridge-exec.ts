import type { BridgeCapability, BridgeJobResult, BridgeRegistry } from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";

const ONLINE_MS = 20_000;

export function resolveBridge(
  registry: BridgeRegistry,
  opts: { bridgeId?: string; name?: string; capability?: BridgeCapability },
): { id: string; name: string } | null {
  const bridges = registry.list();
  if (!bridges.length) return null;
  const now = Date.now();
  const online = bridges.filter((b) => {
    if (now - b.lastSeenAt > ONLINE_MS) return false;
    if (opts.capability && !b.capabilities.includes(opts.capability)) return false;
    return true;
  });
  if (opts.bridgeId) {
    const match = online.find((b) => b.id === opts.bridgeId);
    return match ? { id: match.id, name: match.name } : null;
  }
  if (opts.name) {
    const needle = opts.name.trim().toLowerCase();
    const match = online.find((b) => b.name.toLowerCase() === needle);
    return match ? { id: match.id, name: match.name } : null;
  }
  const freshest = [...online].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  return freshest ? { id: freshest.id, name: freshest.name } : null;
}

export async function runShellOnBridge(
  registry: BridgeRegistry,
  opts: {
    bridgeId?: string;
    name?: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
    idempotencyKey?: string;
  },
): Promise<BridgeJobResult & { bridgeName: string }> {
  const command = opts.command.trim();
  if (!command) throw new Error("command required");
  const bridge = resolveBridge(registry, { ...opts, capability: "shell" });
  if (!bridge) throw new Error("no online bridge matched");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const job = registry.enqueueShell(bridge.id, command, opts.cwd, timeoutMs, {
    idempotencyKey: opts.idempotencyKey,
  });
  const result = await waitForBridgeJobResult(registry, job.id, timeoutMs, bridge.name);
  return { ...result, bridgeName: bridge.name };
}

export async function runSshOnBridge(
  registry: BridgeRegistry,
  opts: {
    bridgeId?: string;
    name?: string;
    alias: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<BridgeJobResult & { bridgeName: string }> {
  const command = opts.command.trim();
  if (!command) throw new Error("command required");
  if (!opts.alias.trim()) throw new Error("ssh alias required");
  const bridge = resolveBridge(registry, { bridgeId: opts.bridgeId, name: opts.name, capability: "ssh-forward" });
  if (!bridge) throw new Error("no online bridge with ssh-forward matched");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const job = registry.enqueueSshExec(bridge.id, opts.alias.trim(), command, opts.cwd, timeoutMs);
  const result = await waitForBridgeJobResult(registry, job.id, timeoutMs, bridge.name);
  return { ...result, bridgeName: bridge.name };
}
