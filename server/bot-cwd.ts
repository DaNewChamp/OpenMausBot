// A bot's working folder — where its shell tools run. Validated here, once,
// so a bad path is refused at PATCH time with a reason the settings panel
// can show, rather than surfacing later as a driver spawn failure.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

export function validateBotCwd(input: unknown): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}

const DATA_DIR_TOKEN = "${DATA_DIR}";

/** Store workspace paths relative to the hub data dir so archives survive host moves. */
export function relativizeCwd(cwd: string | null | undefined, dataDir: string): string | null {
  if (!cwd) return cwd ?? null;
  const resolvedData = resolve(dataDir);
  const resolvedCwd = resolve(cwd);
  if (resolvedCwd === resolvedData || resolvedCwd.startsWith(resolvedData + "/") || resolvedCwd.startsWith(resolvedData + "\\")) {
    const rest = resolvedCwd.slice(resolvedData.length).replace(/^[/\\]/, "");
    return rest ? `${DATA_DIR_TOKEN}/${rest.replaceAll("\\", "/")}` : DATA_DIR_TOKEN;
  }
  return cwd;
}

export function resolvePortableCwd(cwd: string | null | undefined, dataDir: string): string | null {
  if (!cwd) return cwd ?? null;
  if (cwd === DATA_DIR_TOKEN) return resolve(dataDir);
  if (cwd.startsWith(`${DATA_DIR_TOKEN}/`) || cwd.startsWith(`${DATA_DIR_TOKEN}\\`)) {
    return resolve(dataDir, cwd.slice(DATA_DIR_TOKEN.length).replace(/^[/\\]/, ""));
  }
  return cwd;
}
