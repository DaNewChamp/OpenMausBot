import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeJob } from "./types.ts";

const execFileAsync = promisify(execFile);

export async function runShellJob(job: Extract<BridgeJob, { kind: "shell" }>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", job.command], {
      cwd: job.cwd,
      timeout: job.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (err.message ?? String(error)),
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runSshJob(job: Extract<BridgeJob, { kind: "ssh-exec" }>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const remote = job.cwd ? `cd ${shellQuote(job.cwd)} && ${job.command}` : job.command;
  try {
    const { stdout, stderr } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", job.alias, remote],
      {
        timeout: job.timeoutMs,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? (err.message ?? String(error)),
    };
  }
}
