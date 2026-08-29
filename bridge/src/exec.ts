import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeJob, BridgeJobResult } from "./types.ts";

const execFileAsync = promisify(execFile);

function failed(error: unknown): BridgeJobResult {
  // SAFETY: bash/ssh execFile rejects with Node's ErrnoException plus captured stdio.
  const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
  const aborted = err.name === "AbortError" || err.code === "ABORT_ERR";
  return {
    exitCode: aborted ? 143 : typeof err.code === "number" ? err.code : 1,
    stdout: err.stdout ?? "",
    stderr: aborted ? "cancelled" : (err.stderr ?? (err.message ?? String(error))),
    truncated: err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  };
}

export async function runShellJob(
  job: Extract<BridgeJob, { kind: "shell" }>,
  signal?: AbortSignal,
): Promise<BridgeJobResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", job.command], {
      cwd: job.cwd,
      timeout: job.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
      signal,
    });
    return { exitCode: 0, stdout, stderr, truncated: false };
  } catch (error) {
    return failed(error);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runSshJob(
  job: Extract<BridgeJob, { kind: "ssh-exec" }>,
  signal?: AbortSignal,
): Promise<BridgeJobResult> {
  const remote = job.cwd ? `cd ${shellQuote(job.cwd)} && ${job.command}` : job.command;
  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", job.alias, remote],
      {
        timeout: job.timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
        signal,
      },
    );
    return { exitCode: 0, stdout, stderr, truncated: false };
  } catch (error) {
    return failed(error);
  }
}
