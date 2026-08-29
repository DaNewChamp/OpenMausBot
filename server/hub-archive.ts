import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { relativizeCwd, resolvePortableCwd } from "./bot-cwd.ts";

export interface HostProfile {
  id: string;
  dataDir: string;
  companionDir?: string;
  config?: Record<string, unknown>;
  botPatches?: Array<Record<string, unknown> & { id: string }>;
}

export interface HubArchiveManifest {
  version: 1;
  exportedAt: string;
  sourceHost?: string;
  includesCompanion: boolean;
  files: string[];
}

const DEFAULT_FILES = [
  "bots.json",
  "groups.json",
  "config.json",
  "bridges.json",
  "bridge-jobs.json",
  "devices.json",
  "messages.db",
  "decisions.ndjson",
  "decisions.ndjson.1",
];

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

export function loadHostProfile(profilesPath: string, id: string): HostProfile {
  const raw = JSON.parse(readFileSync(profilesPath, "utf8")) as Record<string, Omit<HostProfile, "id">>;
  const profile = raw[id];
  if (!profile) throw new Error(`unknown host profile: ${id}`);
  return {
    id,
    dataDir: expandHome(profile.dataDir),
    companionDir: profile.companionDir ? expandHome(profile.companionDir) : undefined,
    config: profile.config,
    botPatches: profile.botPatches,
  };
}

function checkpointMessages(dataDir: string): void {
  const db = join(dataDir, "messages.db");
  if (!existsSync(db)) return;
  try {
    execFileSync("sqlite3", [db, "PRAGMA wal_checkpoint(FULL);"], { encoding: "utf8" });
  } catch {
    /* optional */
  }
}

function remapBots(botsPath: string, dataDir: string, mode: "export" | "import"): void {
  if (!existsSync(botsPath)) return;
  const bots = JSON.parse(readFileSync(botsPath, "utf8")) as Array<{ cwd?: string; tasks?: Array<{ cwd?: string | null }> }>;
  for (const bot of bots) {
    if (typeof bot.cwd === "string") {
      bot.cwd = (mode === "export" ? relativizeCwd(bot.cwd, dataDir) : resolvePortableCwd(bot.cwd, dataDir)) ?? undefined;
    }
    for (const task of bot.tasks ?? []) {
      if (typeof task.cwd === "string") {
        task.cwd = mode === "export" ? relativizeCwd(task.cwd, dataDir) : resolvePortableCwd(task.cwd, dataDir);
      }
    }
  }
  writeFileSync(botsPath, `${JSON.stringify(bots, null, 2)}\n`);
}

export function applyHostProfile(dataDir: string, profile: HostProfile): void {
  const botsPath = join(dataDir, "bots.json");
  if (existsSync(botsPath) && profile.botPatches?.length) {
    const bots = JSON.parse(readFileSync(botsPath, "utf8")) as Array<Record<string, unknown>>;
    for (const patch of profile.botPatches) {
      const bot = bots.find((entry) => entry.id === patch.id);
      if (!bot) continue;
      Object.assign(bot, patch);
    }
    writeFileSync(botsPath, `${JSON.stringify(bots, null, 2)}\n`);
  }
  if (profile.config && Object.keys(profile.config).length) {
    const configPath = join(dataDir, "config.json");
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
    Object.assign(config, profile.config);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

export function exportHubArchive(opts: {
  dataDir: string;
  destDir: string;
  companionDir?: string;
  sourceHost?: string;
}): HubArchiveManifest {
  const dest = resolve(opts.destDir);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  checkpointMessages(opts.dataDir);
  const files: string[] = [];
  for (const name of DEFAULT_FILES) {
    const src = join(opts.dataDir, name);
    if (!existsSync(src)) continue;
    writeFileSync(join(dest, name), readFileSync(src));
    files.push(name);
  }
  for (const extra of ["workspaces", "vm-homes", "vm-home"]) {
    const src = join(opts.dataDir, extra);
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    copyDir(src, join(dest, extra));
    files.push(`${extra}/`);
  }
  remapBots(join(dest, "bots.json"), opts.dataDir, "export");
  let includesCompanion = false;
  if (opts.companionDir && existsSync(opts.companionDir)) {
    copyDir(opts.companionDir, join(dest, "companion"));
    includesCompanion = true;
    files.push("companion/");
  }
  const manifest: HubArchiveManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceHost: opts.sourceHost,
    includesCompanion,
    files,
  };
  writeFileSync(join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function importHubArchive(opts: {
  archiveDir: string;
  dataDir: string;
  companionDir?: string;
  profile?: HostProfile;
}): HubArchiveManifest {
  const src = resolve(opts.archiveDir);
  const manifestPath = join(src, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("hub archive missing manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as HubArchiveManifest;
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(src)) {
    if (name === "manifest.json" || name === "companion") continue;
    const from = join(src, name);
    const to = join(opts.dataDir, name);
    if (statSync(from).isDirectory()) copyDir(from, to);
    else writeFileSync(to, readFileSync(from));
  }
  remapBots(join(opts.dataDir, "bots.json"), opts.dataDir, "import");
  if (opts.profile) applyHostProfile(opts.dataDir, opts.profile);
  if (manifest.includesCompanion && opts.companionDir && existsSync(join(src, "companion"))) {
    mkdirSync(opts.companionDir, { recursive: true, mode: 0o700 });
    copyDir(join(src, "companion"), opts.companionDir);
  }
  return manifest;
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    if (name === "node_modules" || name.endsWith(".db-shm") || name.endsWith(".db-wal")) continue;
    const src = join(from, name);
    const dest = join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dest);
    else writeFileSync(dest, readFileSync(src));
  }
}
