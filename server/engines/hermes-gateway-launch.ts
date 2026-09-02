import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export const HERMES_GATEWAY_MODULE = "tui_gateway.entry";
const GATEWAY_ENTRY_REL = join("tui_gateway", "entry.py");

export interface HermesGatewayLaunch {
  command: string;
  args: readonly ["-m", typeof HERMES_GATEWAY_MODULE];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type HermesGatewayLaunchError = { error: "missing_cli" };

export interface HermesGatewayLaunchInput {
  cli: string;
  cwd?: string;
  environment: NodeJS.ProcessEnv;
}

export interface HermesGatewayLaunchDeps {
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  platform?: NodeJS.Platform;
}

function defaultExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function defaultRealpath(path: string): string {
  try {
    const native = (realpathSync as typeof realpathSync & { native?: (target: string) => string }).native;
    return native ? native(path) : realpathSync(path);
  } catch {
    return path;
  }
}

function hasGatewayEntry(root: string, exists: (path: string) => boolean): boolean {
  return exists(join(root, GATEWAY_ENTRY_REL));
}

function readShebangPython(cliPath: string, readFile: (path: string, encoding: BufferEncoding) => string): string | undefined {
  try {
    const first = readFile(cliPath, "utf8").split("\n", 1)[0]?.trim();
    if (!first?.startsWith("#!")) return undefined;
    const interpreter = first.slice(2).trim().split(/\s+/)[0];
    return interpreter || undefined;
  } catch {
    return undefined;
  }
}

function siblingPython(binDir: string, platform: NodeJS.Platform, exists: (path: string) => boolean): string | undefined {
  const candidates = platform === "win32"
    ? [join(binDir, "python.exe"), join(binDir, "python3.exe")]
    : [join(binDir, "python3"), join(binDir, "python")];
  return candidates.find((candidate) => exists(candidate));
}

function venvPythonCandidates(venvRoot: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return [join(venvRoot, "Scripts", "python.exe"), join(venvRoot, "Scripts", "python3.exe")];
  }
  return [join(venvRoot, "bin", "python3"), join(venvRoot, "bin", "python")];
}

function isHermesCliName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "hermes" || lower === "hermes.exe" || lower === "hermes-script.py";
}

function resolveCliPath(
  cli: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  realpath: (path: string) => string,
): string | undefined {
  const trimmed = cli.trim();
  if (!trimmed) return undefined;

  const hasPathSeparator = trimmed.includes("/") || trimmed.includes("\\");
  if (hasPathSeparator || isAbsolute(trimmed)) {
    const candidate = resolve(trimmed);
    if (!exists(candidate)) return undefined;
    return realpath(candidate);
  }

  if (exists(trimmed)) return realpath(trimmed);

  const pathEnv = environment.PATH?.trim();
  if (!pathEnv) return undefined;
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${trimmed}${ext}`);
      if (exists(candidate)) return realpath(candidate);
    }
  }
  return undefined;
}

function deriveSourceRootFromCli(
  cliPath: string,
  exists: (path: string) => boolean,
): string | undefined {
  const name = basename(cliPath);
  if (isHermesCliName(name)) {
    const binDir = dirname(cliPath);
    const binName = basename(binDir).toLowerCase();
    if (binName === "bin" || binName === "scripts") {
      const venvRoot = dirname(binDir);
      const repoRoot = dirname(venvRoot);
      if (hasGatewayEntry(repoRoot, exists)) return repoRoot;
      if (hasGatewayEntry(venvRoot, exists)) return venvRoot;
    }
  }

  let dir = dirname(cliPath);
  for (let depth = 0; depth < 8; depth += 1) {
    if (hasGatewayEntry(dir, exists)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function derivePythonFromCli(
  cliPath: string,
  sourceRoot: string,
  environment: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  readFile: (path: string, encoding: BufferEncoding) => string,
  platform: NodeJS.Platform,
): string | undefined {
  const configured = environment.HERMES_PYTHON?.trim();
  if (configured) return configured;

  if (exists(cliPath)) {
    const shebang = readShebangPython(cliPath, readFile);
    if (shebang && exists(shebang)) return shebang;
  }

  const sibling = siblingPython(dirname(cliPath), platform, exists);
  if (sibling) return sibling;

  for (const venvName of [".venv", "venv"]) {
    for (const candidate of venvPythonCandidates(join(sourceRoot, venvName), platform)) {
      if (exists(candidate)) return candidate;
    }
  }

  const cliBin = dirname(cliPath);
  const cliBinName = basename(cliBin).toLowerCase();
  if (cliBinName === "bin" || cliBinName === "scripts") {
    for (const candidate of venvPythonCandidates(dirname(cliBin), platform)) {
      if (exists(candidate)) return candidate;
    }
  }

  return platform === "win32" ? "python" : "python3";
}

/** Resolve the Python gateway process Hermes TUI would spawn for JSON-RPC stdio. */
export function resolveHermesGatewayLaunch(
  input: HermesGatewayLaunchInput,
  deps: HermesGatewayLaunchDeps = {},
): HermesGatewayLaunch | HermesGatewayLaunchError {
  const exists = deps.exists ?? defaultExists;
  const realpath = deps.realpath ?? defaultRealpath;
  const readFile = deps.readFile ?? ((path, encoding) => readFileSync(path, encoding));
  const platform = deps.platform ?? process.platform;
  const environment = input.environment;

  let sourceRoot = environment.HERMES_PYTHON_SRC_ROOT?.trim();
  if (sourceRoot) {
    sourceRoot = resolve(sourceRoot);
    if (!hasGatewayEntry(sourceRoot, exists)) return { error: "missing_cli" };
  } else {
    const cliPath = resolveCliPath(input.cli, environment, platform, exists, realpath);
    if (!cliPath) return { error: "missing_cli" };
    sourceRoot = deriveSourceRootFromCli(cliPath, exists);
    if (!sourceRoot) return { error: "missing_cli" };
  }

  const cliPath = resolveCliPath(input.cli, environment, platform, exists, realpath) ?? join(sourceRoot, "bin", "hermes");
  const python = derivePythonFromCli(cliPath, sourceRoot, environment, exists, readFile, platform);
  if (!python) return { error: "missing_cli" };

  const gatewayCwd = input.cwd?.trim() || environment.HERMES_CWD?.trim() || sourceRoot;
  const outputEnv = { ...environment };
  const existingPyPath = outputEnv.PYTHONPATH?.trim();
  outputEnv.PYTHONPATH = existingPyPath ? `${sourceRoot}${delimiter}${existingPyPath}` : sourceRoot;

  return {
    command: python,
    args: ["-m", HERMES_GATEWAY_MODULE],
    cwd: gatewayCwd,
    env: outputEnv,
  };
}

export function isHermesGatewayLaunchError(
  value: HermesGatewayLaunch | HermesGatewayLaunchError,
): value is HermesGatewayLaunchError {
  return "error" in value;
}
