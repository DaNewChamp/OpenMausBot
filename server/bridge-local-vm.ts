import type { BridgeJobResult, BridgeRegistry, LocalVmBridgeJobKind, LocalVmJobPayload } from "./bridge-registry.ts";
import { waitForBridgeJobResult } from "./bridge-job-wait.ts";
import { resolveBridge } from "./bridge-exec.ts";
import { containerRuntimeStatus } from "./container-computer.ts";

export type LocalVmBridgeOp = "status" | "action" | "screenshot" | "input" | "invoke";

export async function shouldRelayLocalVm(registry: BridgeRegistry, bridgeId?: string): Promise<boolean> {
  if (bridgeId) return true;
  if (process.env.OMB_LOCAL_VM_RELAY === "1") return true;
  const runtime = await containerRuntimeStatus();
  if (runtime.runtime && runtime.daemonUp) return false;
  return resolveBridge(registry, { capability: "local-vm" }) !== null;
}

export function cancelLocalVmInvokeJobs(
  registry: BridgeRegistry,
  match: (payload: LocalVmJobPayload) => boolean,
): string[] {
  const cancelled: string[] = [];
  for (const record of registry.listJobs()) {
    if (record.job.kind !== "local-vm-invoke") continue;
    if (record.status !== "queued" && record.status !== "running") continue;
    if (!match(record.job.payload)) continue;
    registry.cancelJob(record.id);
    cancelled.push(record.id);
  }
  return cancelled;
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
    input?: LocalVmJobPayload["input"];
    threadId?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
    onEnqueued?: (jobId: string) => void;
  },
): Promise<{ data: unknown; bridgeName: string }> {
  const bridge = resolveBridge(registry, { bridgeId: opts.bridgeId, name: opts.name, capability: "local-vm" });
  if (!bridge) {
    if (opts.bridgeId) {
      const assigned = registry.list().find((entry) => entry.id === opts.bridgeId);
      if (!assigned) throw new Error("assigned Local VM host is no longer paired");
      if (!assigned.online) throw new Error(`assigned Local VM host "${assigned.name}" is offline`);
      throw new Error(`assigned host "${assigned.name}" cannot run a Local VM`);
    }
    throw new Error("no online bridge with local-vm matched");
  }
  const kind: LocalVmBridgeJobKind =
    opts.op === "status"
      ? "local-vm-status"
      : opts.op === "screenshot"
        ? "local-vm-screenshot"
        : opts.op === "input"
          ? "local-vm-input"
          : opts.op === "invoke"
            ? "local-vm-invoke"
            : "local-vm-action";
  const timeoutMs =
    opts.timeoutMs ??
    (opts.op === "screenshot" || opts.op === "input"
      ? 90_000
      : opts.op === "action" || opts.op === "invoke"
        ? 10 * 60_000
        : 120_000);
  const job = registry.enqueueLocalVmJob(
    bridge.id,
    kind,
    {
      botId: opts.botId,
      action: opts.action,
      input: opts.input,
      threadId: opts.threadId,
      tool: opts.tool,
      arguments: opts.arguments,
    },
    timeoutMs,
  );
  opts.onEnqueued?.(job.id);
  const result = await waitForBridgeJobResult(registry, job.id, timeoutMs, bridge.name, opts.signal);
  return { data: parseBridgeJson(result), bridgeName: bridge.name };
}
