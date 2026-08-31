import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { augmentedPath } from "./env-path.ts";
import { execCliWithChild, killCliTree } from "./procs.ts";
import type { ApprovalExplanationReviewer, ApprovalReviewInput } from "./approval-explainer.ts";
import {
  APPROVAL_REVIEW_JSON_SCHEMA,
  buildApprovalReviewPrompt,
  extractReviewedJson,
  type ReviewDriverFamily,
} from "./approval-reviewer.ts";

export type IsolatedCliRunner = (
  cli: string,
  args: string[],
  opts: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number },
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
) => ChildProcess | void;

const KNOWN_REVIEWER_CLIS = new Set(["claude", "claude-code", "cursor", "cursor-agent", "codex", "codex-cli"]);

/** Accept only a single known executable. A configured `env foo`, `npx`, or
 * `wrapper --flag` is intentionally rejected: leading arguments can bypass
 * the no-tools argv checks below. Absolute paths are allowed for packaged or
 * versioned installs, but their basename must still be known. */
export function validateReviewerCli(value: string): string | null {
  const cli = value.trim();
  if (!cli || /[\r\n\u0000]/.test(cli) || /[;&|`$<>]/.test(cli)) return null;
  const pathLike = cli.includes("/") || cli.includes("\\");
  if (pathLike) {
    const absolute = cli.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cli) || cli.startsWith("\\\\");
    if (!absolute) return null;
    const name = basename(cli.replace(/\\/g, "/")).toLowerCase().replace(/\.(?:cmd|exe|bat|sh)$/i, "");
    return KNOWN_REVIEWER_CLIS.has(name) ? cli : null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(cli)) return null;
  return KNOWN_REVIEWER_CLIS.has(cli.toLowerCase().replace(/\.(?:cmd|exe|bat|sh)$/i, "")) ? cli : null;
}

function executableFile(cli: string): boolean {
  try {
    return existsSync(cli) && statSync(cli).isFile();
  } catch {
    return false;
  }
}

/** Environment supplied to a subscription CLI. OAuth state lives under HOME;
 * workspace/provider credentials and unrelated deployment secrets do not. */
export function minimalCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allow = new Set([
    "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "TERM_PROGRAM", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "SystemRoot", "SYSTEMROOT",
    "COMSPEC", "NO_COLOR",
  ]);
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
  for (const name of allow) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH = augmentedPath();
  return env;
}

const DEFAULT_MAX_BYTES = 32_768;

export function claudeIsolatedReviewArgs(prompt: string, model: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(APPROVAL_REVIEW_JSON_SCHEMA),
    "--tools",
    "",
    "--strict-mcp-config",
    "--safe-mode",
    "--no-session-persistence",
    "--model",
    model,
  ];
}

export function cursorIsolatedReviewArgs(_prompt: string, _model: string): never {
  throw new Error("Cursor reviewer is unavailable: no tool-free CLI mode is proven");
}

export function codexIsolatedReviewArgs(_prompt: string, _model: string): never {
  throw new Error("Codex OAuth reviewer is unavailable: no tool-free CLI mode is proven");
}

export function isolatedReviewArgs(family: ReviewDriverFamily, prompt: string, model: string): string[] | null {
  if (family === "claude") return claudeIsolatedReviewArgs(prompt, model);
  return null;
}

export function isolatedReviewEnv(_family: ReviewDriverFamily, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return minimalCliEnv(source);
}

export function assertIsolatedReviewArgs(family: ReviewDriverFamily, args: string[]): void {
  if (family === "cursor" || family === "codex") {
    throw new Error(`${family === "cursor" ? "Cursor" : "Codex"} reviewer is unavailable: no tool-free CLI mode is proven`);
  }
  if (family !== "claude") throw new Error("this CLI cannot run an isolated approval review");
  const text = args.join(" ");
  if (/\bmcp\b/i.test(text) && !text.includes("--strict-mcp-config")) {
    throw new Error("isolated review must not enable MCP");
  }
  if (args.includes("--force") || args.includes("--yolo") || args.includes("--approve-mcps")) {
    throw new Error("isolated review must not auto-approve tools");
  }
  if (!(args.includes("--tools") && args[args.indexOf("--tools") + 1] === "")) {
    throw new Error("Claude isolated review requires --tools \"\"");
  }
  if (!args.includes("--strict-mcp-config") || !args.includes("--no-session-persistence")) {
    throw new Error("Claude isolated review requires strict MCP isolation and no session persistence");
  }
}

function timeoutMs(signal: AbortSignal): number {
  const anySignal = signal as AbortSignal & { timeout?: number };
  if (typeof anySignal.timeout === "number") return anySignal.timeout;
  return 1_500;
}

const helpCache = new Map<string, { expiresAt: number; help: string; installed: boolean }>();
const HELP_TTL_MS = 60_000;

export async function probeCliHelp(
  cli: string,
  run: IsolatedCliRunner = execCliWithChild,
): Promise<{ installed: boolean; help: string }> {
  const name = validateReviewerCli(cli);
  if (!name) return { installed: false, help: "" };
  const cached = helpCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return { installed: cached.installed, help: cached.help };
  const candidate = name.includes("/") || name.includes("\\") ? name : undefined;
  const installed = candidate ? executableFile(candidate) : Boolean(augmentedPath().split(delimiter).some((dir) => executableFile(join(dir, name))));
  if (!installed) {
    const miss = { installed: false, help: "", expiresAt: Date.now() + HELP_TTL_MS };
    helpCache.set(name, miss);
    return miss;
  }
  const help = await new Promise<string>((resolve) => {
    run(name, ["--help"], { timeout: 2_000, maxBuffer: 16_384, env: isolatedReviewEnv("claude") }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`.slice(0, 16_384));
    });
  });
  const hit = { installed: true, help, expiresAt: Date.now() + HELP_TTL_MS };
  helpCache.set(name, hit);
  return hit;
}

export async function probeReviewerHints(
  instances: readonly { cli?: string; cliDefault?: string }[],
  run: IsolatedCliRunner = execCliWithChild,
): Promise<{ helpTextByCli: Record<string, string>; installedByCli: Record<string, boolean>; validCliByName: Record<string, boolean> }> {
  const names = [...new Set(
    instances.map((instance) => instance.cli?.trim() || instance.cliDefault?.trim()).filter((name): name is string => Boolean(name)),
  )];
  const helpTextByCli: Record<string, string> = {};
  const installedByCli: Record<string, boolean> = {};
  const validCliByName: Record<string, boolean> = {};
  await Promise.all(names.map(async (rawName) => {
    const name = rawName.trim();
    validCliByName[name] = validateReviewerCli(name) !== null;
    const probed = await probeCliHelp(name, run);
    helpTextByCli[name] = probed.help;
    installedByCli[name] = probed.installed;
  }));
  return { helpTextByCli, installedByCli, validCliByName };
}

export function parseIsolatedCliOutput(stdout: string): unknown {
  const visit = (value: unknown, depth = 0): unknown => {
    if (depth > 6 || value === null || value === undefined) return null;
    if (typeof value === "string") {
      const parsed = extractReviewedJson(value);
      return parsed && typeof parsed === "object" ? visit(parsed, depth + 1) : null;
    }
    if (typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.purpose === "string" && typeof record.change === "string" &&
      typeof record.where === "string" && typeof record.risk === "string") return value;
    for (const nested of Object.values(record)) {
      const found = visit(nested, depth + 1);
      if (found) return found;
    }
    return null;
  };

  const direct = visit(extractReviewedJson(stdout));
  if (direct) return direct;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const found = visit(JSON.parse(line));
      if (found) return found;
    } catch {
      /* non-JSON progress line */
    }
  }
  return null;
}

export async function reviewViaIsolatedCli(input: {
  cli: string;
  family: ReviewDriverFamily;
  model: string;
  prompt: string;
  signal: AbortSignal;
  run?: IsolatedCliRunner;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
}): Promise<unknown> {
  const cli = validateReviewerCli(input.cli);
  if (!cli) throw new Error("approval reviewer CLI must be a bare known executable or absolute path");
  const args = isolatedReviewArgs(input.family, input.prompt, input.model);
  if (!args) throw new Error("this CLI cannot run an isolated approval review");
  assertIsolatedReviewArgs(input.family, args);
  const cwd = mkdtempSync(join(tmpdir(), "omb-approval-review-"));
  const env = isolatedReviewEnv(input.family, input.env);
  const run = input.run ?? execCliWithChild;
  const requestedMaxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < 1) throw new Error("approval reviewer output cap is invalid");
  const maxBytes = Math.min(requestedMaxBytes, DEFAULT_MAX_BYTES);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      let child: ChildProcess | void;
      let settled = false;
      const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
      const terminate = async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await waitForChildExit(child);
      };
      const abort = () => {
        void terminate().finally(() => {
          if (settled) return;
          settled = true;
          reject(abortError());
        });
      };
      if (input.signal.aborted) {
        abort();
        return;
      }
      child = run(
        cli,
        args,
        { timeout: timeoutMs(input.signal), cwd, env, maxBuffer: maxBytes },
        (err: Error | null, out: string) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve(out);
        },
      );
      input.signal.addEventListener(
        "abort",
        abort,
        { once: true },
      );
    });
    return parseIsolatedCliOutput(stdout.slice(0, maxBytes));
  } finally {
    try {
      rmSync(cwd, { recursive: true });
    } catch {
      /* temp dir */
    }
  }
}

export function waitForChildExit(child: ChildProcess, stop: (child: ChildProcess) => void = killCliTree): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    child.once("close", finish);
    child.once("exit", finish);
    stop(child);
  });
}

export function createCliReviewer(input: {
  cli: string;
  family: ReviewDriverFamily;
  model: string;
  run?: IsolatedCliRunner;
  env?: NodeJS.ProcessEnv;
}): ApprovalExplanationReviewer {
  return (reviewInput: ApprovalReviewInput, signal: AbortSignal) =>
    reviewViaIsolatedCli({
      cli: input.cli,
      family: input.family,
      model: input.model,
      prompt: buildApprovalReviewPrompt(reviewInput),
      signal,
      run: input.run,
      env: input.env,
    });
}
