// Windows CLI helpers.
//
// CLIs installed via npm/yarn/pnpm on Windows ship as .cmd batch shims
// (e.g. `codex.cmd` in %APPDATA%\npm). child_process cannot execute .cmd
// files directly — spawn/execFile fail with ENOENT unless the command runs
// through cmd.exe, and going through cmd.exe re-opens argv to its quoting
// and %VAR% expansion rules. Instead we resolve the shim to the real JS
// entry and run it with process.execPath — no shell at all. Native
// installers (the claude installer → claude.exe) resolve to their .exe.
//
// All helpers are async (or spawn async children) — nothing here blocks
// the harness event loop.
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const IS_WIN = process.platform === "win32";
const SHIM_RE = /\.(cmd|bat)$/i;

// `where` results don't change often; cache per CLI so per-turn spawns
// don't pay a fresh `where` process each time.
const whereCache = new Map<string, { path: string; at: number }>();
const WHERE_TTL = 60_000;

/** Resolve a CLI name to a path that can actually be spawned. */
export function resolveCli(cli: string): string {
  if (!IS_WIN) return cli;
  const hit = whereCache.get(cli);
  if (hit && Date.now() - hit.at < WHERE_TTL) return hit.path;
  let resolved = cli;
  try {
    const out = spawnSync("where", [cli], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (out.status === 0 && out.stdout) {
      const candidates = out.stdout
        .split(/\r?\n/)
        .map((c) => c.trim())
        .filter(Boolean);
      const exe = candidates.find((c) => /\.exe$/i.test(c));
      const shim = candidates.find((c) => SHIM_RE.test(c));
      resolved = exe ?? shim ?? cli;
    }
  } catch {
    /* keep the raw name */
  }
  whereCache.set(cli, { path: resolved, at: Date.now() });
  return resolved;
}

// npm/pnpm/yarn .cmd shims are thin wrappers that exec node on a JS entry
// (e.g. `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`). Extract that
// entry so we can spawn process.execPath directly and skip cmd.exe.
function shimScriptTarget(shim: string): string | null {
  try {
    const text = readFileSync(shim, "utf8");
    const m = text.match(/"([^"]+\.(?:[cm]?js))"/);
    if (!m) return null;
    const raw = m[1].replace(/%(?:~)?dp0%/gi, dirname(shim) + "\\");
    if (raw.includes("%")) return null; // unknown var token — give up
    return isAbsolute(raw) ? raw : resolve(dirname(shim), raw);
  } catch {
    return null;
  }
}

/**
 * How to spawn a CLI on this platform:
 * - POSIX: the raw name (resolved via PATH by the shell-less spawn).
 * - Windows: the resolved .exe, or — for .cmd shims — node running the
 *   shim's real JS entry, which needs no cmd.exe at all.
 * Falls back to the raw name when nothing better can be resolved.
 */
export function resolveCliCommand(
  cli: string,
): { command: string; args: string[]; env?: Record<string, string> } {
  if (!IS_WIN) return { command: cli, args: [] };
  const resolved = resolveCli(cli);
  if (SHIM_RE.test(resolved)) {
    const script = shimScriptTarget(resolved);
    if (script) {
      return {
        command: process.execPath,
        args: [script],
        // packaged: process.execPath is the Electron binary; run as plain node
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }
  return { command: resolved, args: [] };
}

/** execFile equivalent that also works for .cmd shims on Windows. */
export function cliExec(
  cli: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { command, args: prefix, env: runEnv } = resolveCliCommand(cli);
  return new Promise((resolvePromise) => {
    const execOpts = {
      timeout: opts.timeout,
      env: { ...opts.env, ...runEnv },
      windowsHide: true,
    };
    const cb = (err: Error | null, stdout: string, stderr: string) =>
      resolvePromise({ ok: !err, stdout, stderr: stderr ?? "" });
    // last-resort: a .cmd shim we couldn't unwrap runs through cmd.exe
    if (IS_WIN && SHIM_RE.test(command)) {
      execFile(command, [...prefix, ...args], { ...execOpts, shell: true }, cb);
    } else {
      execFile(command, [...prefix, ...args], execOpts, cb);
    }
  });
}

/** `cli --version` probe; null when the CLI is missing or errors. */
export function cliVersion(cli: string, timeoutMs = 8000): Promise<string | null> {
  return cliExec(cli, ["--version"], { timeout: timeoutMs }).then((r) =>
    r.ok && r.stdout.trim() ? r.stdout.trim() : null,
  );
}

/**
 * Kill a spawned CLI and its whole process tree (child MCP servers, the
 * codex app-server worker, etc.). POSIX uses the process group
 * (children are spawned detached); Windows uses taskkill /T /F because
 * process.kill(-pid) throws ESRCH and plain kill() leaves orphans.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WIN) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// PowerShell wrapper that runs a CLI with a hidden console. windowsHide on
// the direct spawn would give the CLI NO console — then every console-app
// it spawns (cmd.exe for device-id probes, MCP servers like cua-driver.exe)
// would create its own VISIBLE console window. A hidden console instead is
// inherited by the whole subtree, so nothing ever flashes. Args travel in a
// JSON file, so there is no cmd/PowerShell quoting hazard.
const PS_HIDDEN_WRAPPER = `param([string]$Cli, [string]$ArgsFile)
$ErrorActionPreference = 'Stop'
$ArgList = @(Get-Content -Raw -LiteralPath $ArgsFile | ConvertFrom-Json)
& $Cli @ArgList
exit $LASTEXITCODE
`;

// PowerShell 5.1 (built into Windows) mangles native args that contain
// embedded quotes — fatal for --mcp-config JSON. PowerShell 7 (pwsh)
// passes argv correctly, so prefer it and fall back to a plain
// windowsHide spawn (direct child hidden; grandchildren may flash).
function resolvePwsh(): string | null {
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    ...(process.env.ProgramW6432 ? [join(process.env.ProgramW6432, "PowerShell", "7", "pwsh.exe")] : []),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Spawn a CLI so that no console window ever appears on Windows — including
 * for anything the CLI itself spawns. POSIX: plain spawn (no-op).
 * Callers pass stdio pipes (["pipe","pipe","pipe"]) and get a child with
 * live stdout/stderr streams.
 */
export function spawnCliHidden(
  cli: string,
  args: string[],
  opts: SpawnOptions & { env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const { command, args: prefix, env: runEnv } = resolveCliCommand(cli);
  if (!IS_WIN) {
    return spawn(command, [...prefix, ...args], opts) as ChildProcessWithoutNullStreams;
  }
  // `detached` is a POSIX-only need here (killProcessTree uses the process
  // group). On Windows it maps to DETACHED_PROCESS — the child gets NO
  // console, and pwsh then exits 0 immediately without running the script
  // or writing a byte, which surfaces as "cli exited 0 before result".
  // Windows reaps the tree with taskkill /T /F, so drop the flag.
  const { detached: _detached, ...winOpts } = opts;
  const pwsh = resolvePwsh();
  if (!pwsh) {
    // no pwsh: plain spawn with the direct child hidden (grandchildren may
    // flash their own consoles — acceptable degradation)
    return spawn(command, [...prefix, ...args], {
      ...winOpts,
      env: { ...opts.env, ...runEnv },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }
  // NOTE: no windowsHide here — PowerShell must keep a (hidden) console so
  // the CLI and its console descendants attach to it instead of flashing.
  const dir = mkdtempSync(join(tmpdir(), "omb-spawn-"));
  const argsFile = join(dir, "args.json");
  const wrapper = join(dir, "wrap.ps1");
  writeFileSync(argsFile, JSON.stringify([...prefix, ...args]));
  writeFileSync(wrapper, PS_HIDDEN_WRAPPER);
  const child = spawn(
    pwsh,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      wrapper,
      "-Cli",
      command,
      "-ArgsFile",
      argsFile,
    ],
    { ...winOpts, env: { ...opts.env, ...runEnv } },
  ) as ChildProcessWithoutNullStreams;
  child.once("close", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return child;
}
