import type { BridgeJobResult, BridgeRegistry, LocalVmBridgeJobKind } from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";
import { resolveBridge } from "./bridge-exec.ts";
import { containerRuntimeStatus } from "./container-computer.ts";

export type LocalVmBridgeOp = "status" | "action" | "screenshot";

export async function shouldRelayLocalVm(registry: BridgeRegistry): Promise<boolean> {
  if (process.env.OMB_LOCAL_VM_RELAY === "1") return true;
  const runtime = await containerRuntimeStatus();
  if (runtime.runtime && runtime.daemonUp) return false;
  return resolveBridge(registry, { capability: "local-vm" }) !== null;
}

function parseBridgeJson(result: BridgeJobResult): unknown {
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "bridge local-vm job failed");
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("bridge local-vm job returned invalid JSON");
  }
}

export async function runLocalVmOnBridge(
  registry: BridgeRegistry,
  opts: {
    bridgeId?: string;
    name?: string;
    botId: string;
    op: LocalVmBridgeOp;
    action?: "run" | "stop" | "remove" | "recreate";
    timeoutMs?: number;
  },
): Promise<{ data: unknown; bridgeName: string }> {
  const bridge = resolveBridge(registry, { bridgeId: opts.bridgeId, name: opts.name, capability: "local-vm" });
  if (!bridge) throw new Error("no online bridge with local-vm matched");
  const kind: LocalVmBridgeJobKind =
    opts.op === "status"
      ? "local-vm-status"
      : opts.op === "screenshot"
        ? "local-vm-screenshot"
        : "local-vm-action";
  const timeoutMs = opts.timeoutMs ?? (opts.op === "screenshot" ? 90_000 : 120_000);
  const job = registry.enqueueLocalVmJob(
    bridge.id,
    kind,
    { botId: opts.botId, action: opts.action },
    timeoutMs,
  );
  const result = await waitForBridgeJobResult(registry, job.id, timeoutMs, bridge.name);
  return { data: parseBridgeJson(result), bridgeName: bridge.name };
}
