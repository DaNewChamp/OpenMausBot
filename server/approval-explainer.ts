// Deterministic, display-only explanations for approval cards.
//
// This parser is deliberately not a security boundary. The approval guard and
// the sandbox remain authoritative; this module only helps a person understand
// what they are being asked to allow. It never executes or rewrites a command.

import { createHash } from "node:crypto";

import { isNarrowApprovalTool, looksDestructive, looksSensitive } from "./auto-approve.ts";
import { sanitizeLocalVmInvokeText } from "./local-vm-invoke.ts";

export type ApprovalRiskLevel = "low" | "medium" | "high";

export interface ApprovalExplanation {
  executiveSummary: string;
  changeSummary: string;
  resourceSummary: string;
  riskLevel: ApprovalRiskLevel;
  confidence: "high" | "medium" | "low";
  source?: "local" | "ai-reviewed";
  /** Optional model wording. Local facts above remain authoritative. */
  advisorySummary?: string;
}

/** Turn the deterministic action summary into the short, human-facing reason
 * shown above the details. This is display copy only: the approval broker
 * still owns the decision and the summary never changes risk or policy. */
export function approvalReason(explanation: ApprovalExplanation, hostLabel?: string): string {
  const host = sanitizeExplanationText(hostLabel ?? "the computer") || "the computer";
  const summary = explanation.executiveSummary.trim();
  const intent = summary
    .replace(/^Inspects\s+/i, "inspect ")
    .replace(/^Reads\s+/i, "read ")
    .replace(/^Lists\s+/i, "list ")
    .replace(/^Searches\s+/i, "search ")
    .replace(/^Shows\s+/i, "show ")
    .replace(/^Counts\s+/i, "count ")
    .replace(/^Publishes\s+/i, "publish ")
    .replace(/^Creates\s+/i, "create ")
    .replace(/^Deletes\s+/i, "delete ")
    .replace(/^Edits\s+/i, "edit ")
    .replace(/^Connects\s+/i, "connect ")
    .replace(/^Uses\s+/i, "use ")
    .replace(/^Runs\s+/i, "run ");

  const action = intent ? `${intent.charAt(0).toLowerCase()}${intent.slice(1)}` : "";
  const actionClause = action
    ? /^(?:may|might|could|can|will|should)\b/i.test(action)
      ? `the bot ${action}`
      : `the bot wants to ${action}`
    : "";

  if (explanation.riskLevel === "low" && intent) {
    return `This request needs your approval because the bot wants to ${intent} on ${host}. Nothing runs unless you approve.`;
  }
  if ((explanation.riskLevel === "high" || explanation.riskLevel === "medium") && actionClause) {
    return `This request needs your approval because ${actionClause} on ${host}. Nothing runs unless you approve.`;
  }
  return "This request needs your approval because the effect of the tool could not be determined safely. Nothing runs unless you approve.";
}

/** Explain the exact scope of a narrow remembered grant without exposing its
 * internal key. The caller only puts this on a card when the broker supplied
 * an allow key, so sensitive/destructive actions never inherit this copy. */
export function approvalGrantSummary(toolLabel: string, command: string, hostLabel: string): string | undefined {
  if (!isNarrowApprovalTool(toolLabel)) return undefined;
  const safeTool = sanitizeExplanationText(toolLabel) || "this tool";
  const safeHost = sanitizeExplanationText(hostLabel) || "this computer";
  const segments = shellSegments(sanitizeLocalVmInvokeText(String(command ?? "").slice(0, 16_000)));
  const program = segments
    .map(firstProgram)
    .find((candidate) => candidate && !["cd", "pushd", "popd"].includes(candidate))
    ?? firstProgram(segments[0] ?? "");
  const isCommand = /terminal|shell|bash|execute|command|bridge|ssh/i.test(safeTool);
  return isCommand && program
    ? `Always allow ${safeTool} to run ${program} commands on ${safeHost}.`
    : `Always allow ${safeTool} for this exact action on ${safeHost}.`;
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

function sanitizeReviewerText(value: string): string {
  return sanitizeLocalVmInvokeText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function parseReviewed(value: unknown, fallback: ApprovalExplanation): ApprovalExplanation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const purpose = typeof candidate.purpose === "string" ? candidate.purpose.trim().slice(0, 240) : "";
  const change = typeof candidate.change === "string" ? candidate.change.trim().slice(0, 240) : "";
  const where = typeof candidate.where === "string" ? candidate.where.trim().slice(0, 240) : "";
  const risk = candidate.risk;
  if (!purpose || !change || !where || (risk !== "low" && risk !== "medium" && risk !== "high")) return null;
  const advisorySummary = sanitizeReviewerText(
    typeof candidate.advisory === "string" ? candidate.advisory : purpose,
  );
  if (!advisorySummary) return null;
  return {
    // The reviewer cannot replace local facts. Its output is retained only as
    // a separately labeled advisory note and never affects approval policy.
    ...fallback,
    advisorySummary,
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
  const localFacts = Object.freeze({ ...deterministic });
  try {
    const value = await Promise.race([
      reviewer(Object.freeze({ tool: safeTool, command, host: safeHost, deterministic: localFacts }), controller.signal),
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

const READ_PROGRAMS = new Set(["cat", "cd", "cut", "echo", "find", "grep", "head", "ls", "pwd", "rg", "sort", "tail", "type", "which", "wc"]);
const GIT_READ_ACTIONS = new Set(["status", "log", "diff", "show"]);
const GIT_REMOTE_READ_ACTIONS = new Set(["get-url", "show"]);
const GIT_REMOTE_READ_FLAGS = new Set(["-v", "--verbose", "-vv"]);
const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "--list", "--show-current"]);
const GIT_BRANCH_MUTATING_FLAGS = /^(?:-[dDmcCf]|--delete|--move|--copy|--set-upstream-to|--unset-upstream|--track|--force)(?:=.*)?$/;
const FIND_MUTATING_FLAGS = /(?:^|[\s"'\\])-(?:delete|exec|execdir|ok|okdir|fprint0|fprintf|fprint|fls)\b/;
const COMPUTER_WORDS = /computer|screenshot|click|type[ _-]?text|press[ _-]?key|scroll|open[ _-]?url|trackpad|touch/i;
const NETWORK_WORDS = /\b(?:curl|wget|ssh|scp|sftp|rsync|nc|netcat|ftp)\b/i;
const MUTATION_WORDS = /(?:^|[\s;&|])(?:rm|rmdir|mv|cp|mkdir|touch|tee|install|uninstall|kill|shutdown|reboot|chmod|chown|docker\s+(?:run|exec|rm|stop|kill)|npm\s+(?:install|publish)|pnpm\s+(?:install|publish)|git\s+(?:commit|push|reset|checkout|clean)|sed\s+-[^;|]*i\b)/i;
const COMMAND_SUBSTITUTION = /\$\(|`/;
const SED_PRINT_ONLY = /^[0-9,$\s{}pPldnq;=]*$/;

function stripHarmlessRedirections(input: string): string {
  return input.replace(/\d*(?:>>?|<)\s*\/dev\/null\b/gi, "");
}

function hasUnsafeRedirection(command: string): boolean {
  if (/\b(?:tee|xargs)\b/i.test(command)) return true;
  return /(?:^|[^<])>{1,2}/.test(stripHarmlessRedirections(command));
}

function shellSegments(input: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  const push = (end: number) => {
    const segment = input.slice(start, end).trim();
    if (segment) result.push(segment);
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
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
    if (character === "\n" || character === "\r") {
      push(index);
      start = index + 1;
      continue;
    }
    if (character === ";" || character === "|") {
      push(index);
      if (input[index + 1] === character) index += 1;
      start = index + 1;
      continue;
    }
    if (character === "&") {
      const next = input[index + 1];
      const prev = index > 0 ? input[index - 1] : "";
      if (next === "&") {
        push(index);
        index += 1;
        start = index + 1;
        continue;
      }
      if (prev === ">" || next === ">") continue;
      push(index);
      start = index + 1;
      continue;
    }
  }
  push(input.length);
  return result;
}

function hasProcessSubstitution(input: string): boolean {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
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
    if ((character === "<" || character === ">") && input[index + 1] === "(") return true;
  }
  return false;
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let inWord = false;
  const flush = () => {
    if (!inWord) return;
    words.push(current);
    current = "";
    inWord = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (escaped) {
      current += character;
      inWord = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      inWord = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      inWord = true;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    current += character;
    inWord = true;
  }
  flush();
  return words;
}

function firstProgram(segment: string): string {
  const withoutAssignments = segment
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/, "")
    .replace(/^(?:env|command|builtin|timeout)\s+(?:\S+\s+)*?/, "");
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

function gitAction(segment: string): string | undefined {
  return gitSubcommandArgs(segment)[0]?.toLowerCase();
}

function gitSubcommandArgs(segment: string): string[] {
  const words = shellWords(stripHarmlessRedirections(segment));
  let index = 0;
  if ((words[0]?.split("/").pop() ?? "").toLowerCase() === "git") index = 1;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "-C" || word === "-c") {
      index += 2;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function gitRemoteIsRead(segment: string): boolean {
  const args = gitSubcommandArgs(segment);
  if (args[0]?.toLowerCase() !== "remote") return false;
  const rest = args.slice(1);
  const positional = rest.filter((word) => !word.startsWith("-"));
  const flags = rest.filter((word) => word.startsWith("-"));
  if (positional.length === 0) return flags.every((flag) => GIT_REMOTE_READ_FLAGS.has(flag));
  return GIT_REMOTE_READ_ACTIONS.has(positional[0]!.toLowerCase());
}

function gitBranchIsRead(segment: string): boolean {
  const args = gitSubcommandArgs(segment);
  if (args[0]?.toLowerCase() !== "branch") return false;
  const rest = args.slice(1);
  const positional = rest.filter((word) => !word.startsWith("-"));
  const flags = rest.filter((word) => word.startsWith("-"));
  if (flags.some((flag) => GIT_BRANCH_MUTATING_FLAGS.test(flag))) return false;
  if (flags.some((flag) => GIT_BRANCH_LIST_FLAGS.has(flag))) return true;
  return positional.length === 0;
}

function findIsRead(segment: string): boolean {
  return !FIND_MUTATING_FLAGS.test(segment);
}

function sedIsRead(segment: string): boolean {
  const words = shellWords(segment);
  const start = words.findIndex((word) => (word.split("/").pop() ?? "").toLowerCase() === "sed");
  if (start < 0) return false;
  const args = words.slice(start + 1);
  let quiet = false;
  const scripts: string[] = [];
  let sawScript = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
      quiet = true;
      continue;
    }
    if (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place=")) return false;
    if (arg === "-f" || arg === "--file" || arg.startsWith("--file=")) return false;
    if (arg === "-e" || arg === "--expression") {
      const script = args[index + 1];
      if (!script) return false;
      scripts.push(script);
      sawScript = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      sawScript = true;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (/i/.test(arg)) return false;
      if (/f/.test(arg)) return false;
      if (/n/.test(arg)) quiet = true;
      continue;
    }
    if (!sawScript) {
      scripts.push(arg);
      sawScript = true;
    }
  }
  if (!quiet || scripts.length === 0) return false;
  return scripts.every((script) => SED_PRINT_ONLY.test(script) && /[pPldnq=]/.test(script));
}

function sanitizeExplanationText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function repositoryLabel(command: string): string | null {
  const target = command.match(/\b(?:cd|ls)\s+(?:[^\s;|&]*\/)?([A-Za-z][A-Za-z0-9_.-]+)/)?.[1];
  return target ? `${target} repository` : null;
}

function humanList(values: string[]): string {
  if (values.length === 0) return "the current workspace";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function resourceContext(command: string, resources: string[]): string {
  return repositoryLabel(command) ?? humanList(resources);
}

function classify(tool: string, command: string, segments: string[]): CommandClass {
  if (looksSensitive(command)) return "sensitive";
  if (looksDestructive(command) || MUTATION_WORDS.test(command) || hasUnsafeRedirection(command)) return "mutating";
  if (COMMAND_SUBSTITUTION.test(command) || hasProcessSubstitution(command)) return "unknown";
  if (COMPUTER_WORDS.test(tool)) return "computer";
  if (NETWORK_WORDS.test(command)) return "network";
  if (!segments.length) return "unknown";
  const allRead = segments.every((segment) => {
    const program = firstProgram(segment);
    if (!program || program === "sudo") return false;
    if (program === "git") {
      const action = gitAction(segment);
      if (action === "remote") return gitRemoteIsRead(segment);
      if (action === "branch") return gitBranchIsRead(segment);
      return action ? GIT_READ_ACTIONS.has(action) : false;
    }
    if (program === "find") return findIsRead(segment);
    if (program === "sed") return sedIsRead(segment);
    if (program === "printf") return true;
    return READ_PROGRAMS.has(program);
  });
  return allRead ? "read" : "unknown";
}

function readActionPhrase(action: string): string | undefined {
  switch (action) {
    case "status": return "repository status";
    case "diff": return "uncommitted code changes";
    case "log": return "recent Git history";
    case "remote": return "configured remotes";
    case "show": return "Git object details";
    case "branch": return "branch names";
    default: return undefined;
  }
}

function readSummary(command: string, resources: string[]): string {
  const segments = shellSegments(command);
  const programs = segments.map(firstProgram);
  const readActions = segments
    .map((segment) => (firstProgram(segment) === "git" ? readActionPhrase(gitAction(segment) ?? "") : undefined))
    .filter((value): value is string => Boolean(value));
  if (programs.includes("ls")) readActions.push("the latest files");
  if (programs.includes("find")) readActions.push(`matching files in ${humanList(resources)}`);
  if (programs.includes("rg") || programs.includes("grep")) readActions.push(`matching text in ${humanList(resources)}`);
  if (programs.some((program) => ["cat", "sed"].includes(program)) && resources.length > 0) {
    readActions.push(humanList(resources));
  }
  for (const segment of segments) {
    const program = firstProgram(segment);
    if (program !== "head" && program !== "tail") continue;
    const operand = segment.replace(/^(?:head|tail)\s+(?:-[A-Za-z0-9]+\s+)*/i, "").trim();
    if (operand && !/^-?\d+$/.test(operand)) readActions.push(humanList([operand.split("/").pop() ?? operand]));
  }
  if (programs.includes("pwd")) readActions.push("the current working folder");
  if (programs.includes("wc")) readActions.push(`line or word counts in ${humanList(resources)}`);

  const uniqueActions = [...new Set(readActions)];
  const repo = repositoryLabel(command);
  if (uniqueActions.length >= 2 && repo) {
    const last = uniqueActions.at(-1)!;
    const prefix = uniqueActions.slice(0, -1).join(", ");
    return `Inspects ${prefix}, and ${last} for the ${repo.replace(/ repository$/, "")} repository`;
  }

  if (uniqueActions.length === 1 && repo && uniqueActions[0] !== repo) {
    const action = uniqueActions[0]!;
    if (action.startsWith("matching ") || action.startsWith("line or word")) {
      return `${action[0]!.toUpperCase()}${action.slice(1)} for the ${repo.replace(/ repository$/, "")} repository`;
    }
    return `Inspects ${action} for the ${repo.replace(/ repository$/, "")} repository`;
  }

  if (programs.includes("git")) {
    const actions = segments.map((segment) => gitAction(segment)).filter((value): value is string => Boolean(value));
    if (actions.includes("status")) return "Checks the repository status";
    if (actions.includes("diff")) return "Reviews uncommitted code changes";
    if (actions.includes("log")) return "Reads recent repository history";
    if (actions.includes("remote")) return "Reads configured Git remotes";
  }
  if (programs.includes("find")) return `Lists matching files in ${humanList(resources)}`;
  if (programs.includes("rg") || programs.includes("grep")) return `Searches ${humanList(resources)} for matching text`;
  if (programs.includes("ls")) return `Lists files and folders in ${humanList(resources)}`;
  if (programs.includes("pwd")) return "Shows the current working folder";
  if (programs.some((program) => ["cat", "head", "tail", "sed"].includes(program))) return `Reads ${humanList(resources)}`;
  if (programs.includes("wc")) return `Counts lines or words in ${humanList(resources)}`;
  return resources.length ? `Reads ${humanList(resources)}` : "Reads information from the computer";
}

function mutatingSummary(command: string, resources: string[]): string {
  const segments = shellSegments(command);
  const programs = segments.map(firstProgram);
  const gitActions = segments
    .map((segment) => (firstProgram(segment) === "git" ? gitAction(segment) : undefined))
    .filter((value): value is string => Boolean(value));
  if (gitActions.includes("push")) return "Publishes local commits to a remote repository";
  if (gitActions.includes("commit")) return "Creates a new repository commit";
  if (gitActions.some((action) => ["reset", "checkout", "clean", "merge", "rebase"].includes(action))) {
    return "Changes repository history or working files";
  }
  if (programs.some((program) => ["rm", "rmdir"].includes(program))) return "Deletes files or folders";
  if (programs.includes("mv")) return "Moves or renames files";
  if (programs.includes("cp")) return "Copies files";
  if (programs.includes("mkdir")) return "Creates folders";
  if (programs.includes("sed")) return "Edits file contents";
  if (programs.includes("npm") || programs.includes("pnpm")) {
    if (/\b(?:npm|pnpm)\s+(?:uninstall|remove)\b/i.test(command)) return "Removes packages from the workspace";
    if (/\b(?:npm|pnpm)\s+install\b/i.test(command)) return "Installs packages in the workspace";
    if (/\b(?:npm|pnpm)\s+publish\b/i.test(command)) return "Publishes a package to a registry";
  }
  if (programs.includes("docker")) return "Changes or controls a container";
  if (programs.includes("kill") || programs.includes("shutdown") || programs.includes("reboot")) {
    return "Stops or restarts a process or computer";
  }
  if (/>/.test(stripHarmlessRedirections(command))) return "Writes command output to a file";
  return resources.length ? `May change ${humanList(resources)}` : "Runs a command that may change files, processes, or system state";
}

/** Shared read-only classifier for approval cards and explanations. */
export function isReadOnlyShellCommand(tool: string, command: string): boolean {
  const safeCommand = sanitizeLocalVmInvokeText(String(command ?? "").slice(0, 16_000));
  return classify(String(tool ?? ""), safeCommand, shellSegments(safeCommand)) === "read";
}

/** Build a bounded, plain-English explanation without running the command. */
export function explainApproval(tool: string, summary: string, hostLabel?: string): ApprovalExplanation {
  const safeCommand = sanitizeLocalVmInvokeText(String(summary ?? "").slice(0, 16_000));
  const segments = shellSegments(safeCommand);
  const kind = classify(String(tool ?? ""), safeCommand, segments);
  const resources = resourceNames(safeCommand);
  const safeHost = String(hostLabel ?? "").replace(/[^A-Za-z0-9 .:_-]/g, "").slice(0, 80);
  const context = resourceContext(safeCommand, resources);
  const where = sanitizeExplanationText(safeHost ? `${context} on ${safeHost}` : context);

  switch (kind) {
    case "read":
      return {
        executiveSummary: sanitizeExplanationText(readSummary(safeCommand, resources)),
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
        executiveSummary: sanitizeExplanationText(mutatingSummary(safeCommand, resources)),
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
        resourceSummary: sanitizeExplanationText(safeHost ? `The desktop on ${safeHost}` : "The computer desktop"),
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
