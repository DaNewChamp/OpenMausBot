import { setTimeout as sleep } from "node:timers/promises";

import type { BridgeJobResult, BridgeRegistry } from "./bridge-registry.ts";

export async function waitForBridgeJobResult(
  registry: BridgeRegistry,
  jobId: string,
  timeoutMs: number,
  bridgeName: string,
): Promise<BridgeJobResult> {
  const deadline = Date.now() + timeoutMs + 20_000;
  while (Date.now() < deadline) {
    registry.reconcile();
    const status = registry.jobStatus(jobId);
    if (status === "cancelled") throw new Error(`bridge job cancelled waiting for ${bridgeName}`);
    if (status === "failed") {
      const record = registry.getJob(jobId);
      throw new Error(record?.error ?? `bridge job failed waiting for ${bridgeName}`);
    }
    const result = registry.result(jobId);
    if (result) return result;
    await sleep(400);
  }
  registry.reconcile(Date.now());
  const late = registry.result(jobId);
  if (late) return late;
  throw new Error(`bridge job timed out waiting for ${bridgeName}`);
}
