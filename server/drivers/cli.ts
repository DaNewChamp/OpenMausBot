// Windows CLI-shim helpers.
//
// CLIs installed via npm/yarn/pnpm on Windows ship as .cmd batch shims
// (e.g. `codex.cmd` in %APPDATA%\npm). child_process cannot execute .cmd
// files directly — spawn/execFile fail with ENOENT unless the command runs
// through cmd.exe. Native installers (the claude installer → claude.exe)
// are unaffected. These helpers resolve the real path via `where` and
// degrade gracefully to the raw name.
import { execFile, spawnSync } from "node:child_process";

const IS_WIN = process.platform === "win32";
const SHIM_RE = /\.(cmd|bat)$/i;

/** Resolve a CLI name to an executable path cmd/spawn can actually run. */
export function resolveCli(cli: string): string {
  if (!IS_WIN) return cli;
  try {
    const out = spawnSync("where", [cli], { encoding: "utf8", timeout: 5000 });
    if (out.status !== 0 || !out.stdout) return cli;
    const candidates = out.stdout.split(/\r?\n/).map((c) => c.trim()).filter(Boolean);
    const exe = candidates.find((c) => /\.exe$/i.test(c));
    if (exe) return exe;
    const shim = candidates.find((c) => SHIM_RE.test(c));
    return shim ?? cli;
  } catch {
    return cli;
  }
}

/** Spawn options that make a .cmd shim runnable (through cmd.exe). */
export function cliSpawnShell(cli: string): { shell?: true } {
  return IS_WIN && SHIM_RE.test(resolveCli(cli)) ? { shell: true } : {};
}

/** execFile equivalent that also works for .cmd shims on Windows. */
export function cliExec(
  cli: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const resolved = resolveCli(cli);
  if (IS_WIN && SHIM_RE.test(resolved)) {
    return new Promise((resolve) => {
      try {
        const out = spawnSync(resolved, args, {
          encoding: "utf8",
          timeout: opts.timeout,
          env: opts.env,
          shell: true,
        });
        resolve({
          ok: out.status === 0,
          stdout: out.stdout ?? "",
          stderr: out.stderr ?? "",
        });
      } catch (e) {
        resolve({ ok: false, stdout: "", stderr: String(e) });
      }
    });
  }
  return new Promise((resolve) => {
    execFile(
      resolved,
      args,
      { timeout: opts.timeout, env: opts.env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: stderr ?? "" }),
    );
  });
}

/** `cli --version` probe; null when the CLI is missing or errors. */
export function cliVersion(cli: string, timeoutMs = 8000): Promise<string | null> {
  return cliExec(cli, ["--version"], { timeout: timeoutMs }).then((r) =>
    r.ok && r.stdout.trim() ? r.stdout.trim() : null,
  );
}
