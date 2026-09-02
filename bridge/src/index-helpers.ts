import type { BridgeJob } from "./types.ts";
import { runHermesBridgeJob, type HermesBridgeJob } from "./hermes.ts";
import { createFakeHermesBridgeRuntime } from "./hermes.ts";
import { bridgeHermesExecutionEnabled } from "./daemon-timing.ts";

export async function handleJob(
  job: BridgeJob,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    job.kind === "hermes-discover"
    || job.kind === "hermes-ensure-canonical"
    || job.kind === "hermes-send"
    || job.kind === "hermes-interrupt"
  ) {
    if (!bridgeHermesExecutionEnabled(env)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "hermes capability disabled locally",
        truncated: false,
      };
    }
    return runHermesBridgeJob(job as HermesBridgeJob, createFakeHermesBridgeRuntime({}), signal);
  }
  return { exitCode: 1, stdout: "", stderr: `unsupported job kind: ${job.kind}`, truncated: false };
}
