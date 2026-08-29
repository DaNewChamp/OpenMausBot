import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeJobResult, PeekabooBridgeJob } from "./types.ts";

const execFileAsync = promisify(execFile);

function peekabooBin(): string {
  return process.env.PEEKABOO_BIN?.trim() || "peekaboo";
}

/** Opt-in Mac host-screen observation. Never click, type, or drive the UI. */
export async function runPeekabooJob(
  job: PeekabooBridgeJob,
  signal?: AbortSignal,
): Promise<BridgeJobResult> {
  const bin = peekabooBin();
  const args =
    job.payload.mode === "see"
      ? ["see", "--question", job.payload.question?.trim() || "What is on screen?"]
      : ["image", "--mode", "screen", "--json"];
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: job.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
      signal,
    });
    return { exitCode: 0, stdout, stderr, truncated: false };
  } catch (error) {
    // SAFETY: execFile rejects with Node's ErrnoException plus captured stdio.
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    const aborted = err.name === "AbortError" || err.code === "ABORT_ERR";
    const missing = err.code === "ENOENT";
    return {
      exitCode: aborted ? 143 : 1,
      stdout: err.stdout ?? "",
      stderr: aborted
        ? "cancelled"
        : missing
          ? "Peekaboo CLI is not installed on this bridge. Install steipete/Peekaboo and set OMB_BRIDGE_PEEKABOO=1."
          : (err.stderr ?? (err.message ?? String(error))),
      truncated: false,
    };
  }
}
