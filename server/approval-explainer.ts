// Deterministic, display-only explanations for approval cards.
//
// This parser is deliberately not a security boundary. The approval guard and
// the sandbox remain authoritative; this module only helps a person understand
// what they are being asked to allow. It never executes or rewrites a command.

import { createHash } from "node:crypto";

import { looksDestructive, looksSensitive } from "./auto-approve.ts";
import { sanitizeLocalVmInvokeText } from "./local-vm-invoke.ts";

export type ApprovalRiskLevel = "low" | "medium" | "high";

export interface ApprovalExplanation {
  executiveSummary: string;
  changeSummary: string;
  resourceSummary: string;
  riskLevel: ApprovalRiskLevel;
  confidence: "high" | "medium" | "low";
  source?: "local" | "ai-reviewed";
}

/** Sanitized, display-only input for an optional BYOK reviewer. It carries no
 * tools, memory, credentials, or authority to approve an action. */
export interface ApprovalReviewInput {
  tool: string;
  command: string;
  host: string;
  deterministic: ApprovalExplanation;
}

/** Provider-neutral seam for a future small model. The caller owns the model
 * and credentials; this module only validates its bounded structured output. */
export type ApprovalExplanationReviewer = (
  input: ApprovalReviewInput,
  signal: AbortSignal,
) => Promise<unknown>;

const REVIEW_CACHE_TTL_MS = 30_000;
const reviewCaches = new WeakMap<ApprovalExplanationReviewer, Map<string, { expiresAt: number; result: ApprovalExplanation }>>();
const identityCaches = new Map<string, Map<string, { expiresAt: number; result: ApprovalExplanation }>>();

function riskRank(level: ApprovalRiskLevel): number {
  return level === "high" ? 3 : level === "medium" ? 2 : 1;
}

function parseReviewed(value: unknown, fallback: ApprovalExplanation): ApprovalExplanation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const purpose = typeof candidate.purpose === "string" ? candidate.purpose.trim().slice(0, 240) : "";
  const change = typeof candidate.change === "string" ? candidate.change.trim().slice(0, 240) : "";
  const where = typeof candidate.where === "string" ? candidate.where.trim().slice(0, 240) : "";
  const risk = candidate.risk;
  if (!purpose || !change || !where || (risk !== "low" && risk !== "medium" && risk !== "high")) return null;
  return {
    executiveSummary: purpose,
    changeSummary: change,
    resourceSummary: where,
    // A reviewer may make the display more cautious, never less cautious than
    // the deterministic guard. The reviewer cannot affect allow/deny policy.
    riskLevel: riskRank(risk) >= riskRank(fallback.riskLevel) ? risk : fallback.riskLevel,
    confidence: "high",
    source: "ai-reviewed",
  };
}

/**
 * Optional BYOK review path. It is intentionally unused by default: callers
 * get the instant local result unless they explicitly supply a no-tools
 * reviewer. Invalid, slow, or failed output falls back to the local result.
 */
export async function reviewApproval(
  tool: string,
  summary: string,
  hostLabel: string,
  reviewer?: ApprovalExplanationReviewer,
  timeoutMs = 1_500,
  cacheIdentity = "",
): Promise<ApprovalExplanation> {
  const deterministic = explainApproval(tool, summary, hostLabel);
  if (!reviewer) return deterministic;
  const command = sanitizeLocalVmInvokeText(String(summary ?? "").slice(0, 16_000));
  const safeTool = String(tool ?? "").replace(/[^A-Za-z0-9 _:-]/g, "").slice(0, 80);
  const safeHost = String(hostLabel ?? "").replace(/[^A-Za-z0-9 .:_-]/g, "").slice(0, 80);
  const key = createHash("sha256").update(JSON.stringify([cacheIdentity, safeTool, command, safeHost])).digest("hex");
  const reviewCache = cacheIdentity
    ? (identityCaches.get(cacheIdentity) ?? new Map<string, { expiresAt: number; result: ApprovalExplanation }>())
    : (reviewCaches.get(reviewer) ?? new Map<string, { expiresAt: number; result: ApprovalExplanation }>());
  if (cacheIdentity) identityCaches.set(cacheIdentity, reviewCache);
  else reviewCaches.set(reviewer, reviewCache);
  const cached = reviewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  reviewCache.delete(key);

  const controller = new AbortController();
  const boundedTimeout = Math.min(Math.max(timeoutMs, 100), 2_500);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      reviewer({ tool: safeTool, command, host: safeHost, deterministic }, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("approval explanation timed out"));
        }, boundedTimeout);
        timer.unref?.();
      }),
    ]);
    const reviewed = parseReviewed(value, deterministic);
    if (!reviewed) return deterministic;
    reviewCache.set(key, { expiresAt: Date.now() + REVIEW_CACHE_TTL_MS, result: reviewed });
    if (reviewCache.size > 128) reviewCache.delete(reviewCache.keys().next().value!);
    return reviewed;
  } catch {
    return deterministic;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type CommandClass = "read" | "computer" | "network" | "mutating" | "sensitive" | "unknown";

const READ_PROGRAMS = new Set(["cat", "cut", "echo", "find", "grep", "head", "ls", "pwd", "rg", "sort", "tail", "type", "which", "wc"]);
const GIT_READ_ACTIONS = new Set(["status", "log", "diff", "show", "branch"]);
const COMPUTER_WORDS = /computer|screenshot|click|type[ _-]?text|press[ _-]?key|scroll|open[ _-]?url|trackpad|touch/i;
const NETWORK_WORDS = /\b(?:curl|wget|ssh|scp|sftp|rsync|nc|netcat|ftp)\b/i;
const MUTATION_WORDS = /(?:^|[\s;&|])(?:rm|rmdir|mv|cp|mkdir|touch|tee|install|uninstall|kill|shutdown|reboot|chmod|chown|docker\s+(?:run|exec|rm|stop|kill)|npm\s+(?:install|publish)|pnpm\s+(?:install|publish)|git\s+(?:commit|push|reset|checkout|clean)|sed\s+-[^;|]*i\b)/i;
const REDIRECTION = /(?:^|[^<])>{1,2}|\b(?:tee|xargs)\b/i;

function shellSegments(input: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === ";" || character === "|") {
      const segment = input.slice(start, index).trim();
      if (segment) result.push(segment);
      if (input[index + 1] === character) index += 1;
      start = index + 1;
    }
  }
  const last = input.slice(start).trim();
  if (last) result.push(last);
  return result;
}

function firstProgram(segment: string): string {
  const withoutAssignments = segment
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, "")
    .replace(/^(?:env|command|builtin|timeout)\s+(?:\S+\s+)*?/, "")
    .replace(/^sudo\s+/, "");
  return withoutAssignments.match(/^(?:["']?)([^\s"']+)/)?.[1]?.split("/").pop()?.toLowerCase() ?? "";
}

function commandTokens(segment: string): string[] {
  return segment.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_./-]+/g) ?? [];
}

function resourceNames(command: string): string[] {
  const names = new Set<string>();
  for (const token of commandTokens(command)) {
    const clean = token.replace(/^[-]+/, "").replace(/[),:]+$/, "");
    if (!clean || clean === "." || clean === ".." || clean.startsWith("-") || clean.includes("://")) continue;
    const basename = clean.split("/").pop() ?? clean;
    if (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$/i.test(basename) || clean === "*" || clean === "./") {
      names.add(basename);
    }
  }
  return [...names].slice(0, 5);
}

function humanList(values: string[]): string {
  if (values.length === 0) return "the current workspace";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function classify(tool: string, command: string, segments: string[]): CommandClass {
  if (looksSensitive(command)) return "sensitive";
  if (looksDestructive(command) || MUTATION_WORDS.test(command) || REDIRECTION.test(command)) return "mutating";
  if (COMPUTER_WORDS.test(tool)) return "computer";
  if (NETWORK_WORDS.test(command)) return "network";
  if (!segments.length) return "unknown";
  const allRead = segments.every((segment) => {
    const program = firstProgram(segment);
    if (program === "git") {
      const action = segment.match(/^git\s+([A-Za-z-]+)/i)?.[1]?.toLowerCase();
      return action ? GIT_READ_ACTIONS.has(action) : false;
    }
    if (program === "sed") return /\bsed\s+-[^;|]*\bn\b/i.test(segment) && !/\s-i(?:\s|$)/i.test(segment);
    if (program === "printf") return true;
    return READ_PROGRAMS.has(program);
  });
  return allRead ? "read" : "unknown";
}

function readSummary(command: string, resources: string[]): string {
  const programs = shellSegments(command).map(firstProgram);
  if (programs.includes("git")) {
    const actions = shellSegments(command)
      .map((segment) => segment.match(/^git\s+([A-Za-z-]+)/i)?.[1]?.toLowerCase())
      .filter((value): value is string => Boolean(value));
    if (actions.includes("status")) return "Checks the repository status";
    if (actions.includes("diff")) return "Reviews uncommitted code changes";
    if (actions.includes("log")) return "Reads recent repository history";
  }
  if (programs.includes("find")) return `Lists matching files in ${humanList(resources)}`;
  if (programs.includes("rg") || programs.includes("grep")) return `Searches ${humanList(resources)} for matching text`;
  if (programs.includes("ls")) return `Lists files and folders in ${humanList(resources)}`;
  if (programs.includes("pwd")) return "Shows the current working folder";
  if (programs.some((program) => ["cat", "head", "tail", "sed"].includes(program))) return `Reads ${humanList(resources)}`;
  if (programs.includes("wc")) return `Counts lines or words in ${humanList(resources)}`;
  return resources.length ? `Reads ${humanList(resources)}` : "Reads information from the computer";
}

/** Build a bounded, plain-English explanation without running the command. */
export function explainApproval(tool: string, summary: string, hostLabel?: string): ApprovalExplanation {
  const safeCommand = sanitizeLocalVmInvokeText(String(summary ?? "").slice(0, 16_000));
  const segments = shellSegments(safeCommand);
  const kind = classify(String(tool ?? ""), safeCommand, segments);
  const resources = resourceNames(safeCommand);
  const safeHost = String(hostLabel ?? "").replace(/[^A-Za-z0-9 .:_-]/g, "").slice(0, 80);
  const where = safeHost ? `${humanList(resources)} on ${safeHost}` : humanList(resources);

  switch (kind) {
    case "read":
      return {
        executiveSummary: readSummary(safeCommand, resources),
        changeSummary: "Nothing; read-only",
        resourceSummary: where,
        riskLevel: "low",
        confidence: "high",
        source: "local",
      };
    case "sensitive":
      return {
        executiveSummary: "Reads information that may contain credentials or private data",
        changeSummary: "Nothing should be changed, but sensitive information may be exposed",
        resourceSummary: where,
        riskLevel: "high",
        confidence: "high",
        source: "local",
      };
    case "mutating":
      return {
        executiveSummary: "Runs a command that may change files, processes, or system state",
        changeSummary: "May create, modify, move, or delete data",
        resourceSummary: where,
        riskLevel: "high",
        confidence: "high",
        source: "local",
      };
    case "network":
      return {
        executiveSummary: "Connects to another computer or online service",
        changeSummary: "May send data or trigger an action outside this computer",
        resourceSummary: where,
        riskLevel: "medium",
        confidence: "high",
        source: "local",
      };
    case "computer":
      return {
        executiveSummary: "Uses the computer to perform the requested on-screen action",
        changeSummary: "May interact with an app or the desktop",
        resourceSummary: safeHost ? `The desktop on ${safeHost}` : "The computer desktop",
        riskLevel: "medium",
        confidence: "high",
        source: "local",
      };
    default:
      return {
        executiveSummary: "Runs a tool requested by the bot",
        changeSummary: "The effect could not be fully determined from the request",
        resourceSummary: where,
        riskLevel: "high",
        confidence: "low",
        source: "local",
      };
  }
}
