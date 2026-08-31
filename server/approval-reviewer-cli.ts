import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripWorkspaceCredentialEnv } from "./config.ts";
import { augmentedPath, findCliCandidates } from "./env-path.ts";
import { execCli } from "./procs.ts";
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
) => void;

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

export function cursorIsolatedReviewArgs(prompt: string, model: string): string[] {
  return ["--print", "--mode", "ask", "--sandbox", "enabled", "--output-format", "json", "--model", model, prompt];
}

export function codexIsolatedReviewArgs(prompt: string, model: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--model",
    model,
    prompt,
  ];
}

export function isolatedReviewArgs(family: ReviewDriverFamily, prompt: string, model: string): string[] | null {
  if (family === "claude") return claudeIsolatedReviewArgs(prompt, model);
  if (family === "cursor") return cursorIsolatedReviewArgs(prompt, model);
  if (family === "codex") return codexIsolatedReviewArgs(prompt, model);
  return null;
}

export function isolatedReviewEnv(_family: ReviewDriverFamily, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  stripWorkspaceCredentialEnv(env);
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  return env;
}

export function assertIsolatedReviewArgs(family: ReviewDriverFamily, args: string[]): void {
  const text = args.join(" ");
  if (/\bmcp\b/i.test(text) && !text.includes("--strict-mcp-config") &&
    !(family === "codex" && args.includes("--ignore-user-config"))) {
    throw new Error("isolated review must not enable MCP");
  }
  if (args.includes("--force") || args.includes("--yolo") || args.includes("--approve-mcps")) {
    throw new Error("isolated review must not auto-approve tools");
  }
  if (family === "claude" && !(args.includes("--tools") && args[args.indexOf("--tools") + 1] === "")) {
    throw new Error("Claude isolated review requires --tools \"\"");
  }
  if (family === "cursor" && (
    !(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "ask") ||
    !(args.includes("--sandbox") && args[args.indexOf("--sandbox") + 1] === "enabled")
  )) {
    throw new Error("Cursor isolated review requires ask mode with sandbox enabled");
  }
  if (family === "codex" && (
    !args.includes("exec") ||
    !args.includes("--ephemeral") ||
    !args.includes("--ignore-user-config") ||
    !args.includes("--skip-git-repo-check") ||
    !args.includes("--sandbox") ||
    args[args.indexOf("--sandbox") + 1] !== "read-only"
  )) {
    throw new Error("Codex isolated review requires ephemeral read-only exec");
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
  run: IsolatedCliRunner = execCli,
): Promise<{ installed: boolean; help: string }> {
  const name = cli.trim();
  if (!name) return { installed: false, help: "" };
  const cached = helpCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return { installed: cached.installed, help: cached.help };
  const installed = findCliCandidates(name).length > 0;
  if (!installed) {
    const miss = { installed: false, help: "", expiresAt: Date.now() + HELP_TTL_MS };
    helpCache.set(name, miss);
    return miss;
  }
  const help = await new Promise<string>((resolve) => {
    run(name, ["--help"], { timeout: 2_000, maxBuffer: 16_384 }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`.slice(0, 16_384));
    });
  });
  const hit = { installed: true, help, expiresAt: Date.now() + HELP_TTL_MS };
  helpCache.set(name, hit);
  return hit;
}

export async function probeReviewerHints(
  instances: readonly { cli?: string; cliDefault?: string }[],
  run: IsolatedCliRunner = execCli,
): Promise<{ helpTextByCli: Record<string, string>; installedByCli: Record<string, boolean> }> {
  const names = [...new Set(
    instances.map((instance) => instance.cli?.trim() || instance.cliDefault?.trim()).filter((name): name is string => Boolean(name)),
  )];
  const helpTextByCli: Record<string, string> = {};
  const installedByCli: Record<string, boolean> = {};
  await Promise.all(names.map(async (name) => {
    const probed = await probeCliHelp(name, run);
    helpTextByCli[name] = probed.help;
    installedByCli[name] = probed.installed;
  }));
  return { helpTextByCli, installedByCli };
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
  const args = isolatedReviewArgs(input.family, input.prompt, input.model);
  if (!args) throw new Error("this CLI cannot run an isolated approval review");
  assertIsolatedReviewArgs(input.family, args);
  const cwd = mkdtempSync(join(tmpdir(), "omb-approval-review-"));
  const env = isolatedReviewEnv(input.family, input.env);
  const run = input.run ?? execCli;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      if (input.signal.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      const child = run(
        input.cli,
        args,
        { timeout: timeoutMs(input.signal), cwd, env, maxBuffer: maxBytes },
        (err, out) => {
          if (err) reject(err);
          else resolve(out);
        },
      );
      input.signal.addEventListener(
        "abort",
        () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
      void child;
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
