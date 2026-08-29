import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeJob, BridgeJobResult } from "./types.ts";

const execFileAsync = promisify(execFile);

type ExecFileFailure = NodeJS.ErrnoException & { stdout?: string; stderr?: string };

function failed(err: ExecFileFailure): BridgeJobResult {
  const aborted = err.name === "AbortError" || err.code === "ABORT_ERR";
  const exitCode = aborted ? 143 : Number.isFinite(err.code) ? Number(err.code) : 1;
  return {
    exitCode,
    stdout: err.stdout ?? "",
    stderr: aborted ? "cancelled" : (err.stderr ?? err.message ?? "command failed"),
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
    // SAFETY: bash/ssh execFile rejects with Node's ErrnoException plus captured stdio.
    return failed(error as ExecFileFailure);
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
    // SAFETY: bash/ssh execFile rejects with Node's ErrnoException plus captured stdio.
    return failed(error as ExecFileFailure);
  }
}
