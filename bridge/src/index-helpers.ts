import type { BridgeJob } from "./types.ts";
import { runHermesBridgeJob, runHermesSignInJob, type HermesBridgeJob } from "./hermes.ts";
import { createFakeHermesBridgeRuntime } from "./hermes.ts";
import { bridgeHermesExecutionEnabled } from "./daemon-timing.ts";
import { runFleetChatJob } from "./local-models.ts";

export async function handleJob(
  job: BridgeJob,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (job.kind === "hermes-signin") {
    if (!bridgeHermesExecutionEnabled(env)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "hermes capability disabled locally",
        truncated: false,
      };
    }
    return runHermesSignInJob(job);
  }
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
  if (job.kind === "fleet-chat") return runFleetChatJob(job, signal);
  return { exitCode: 1, stdout: "", stderr: `unsupported job kind: ${job.kind}`, truncated: false };
}
