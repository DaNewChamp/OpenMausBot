#!/usr/bin/env node
// Daily cloud backup for OpenMausBot data (bots, hierarchy, transcripts, rooms, routines).
//
//   node scripts/backup-openmausbot-cloud.mjs
//   node scripts/backup-openmausbot-cloud.mjs --source-host servarica --host-label servarica
//   node scripts/backup-openmausbot-cloud.mjs list
//   node scripts/backup-openmausbot-cloud.mjs pull --stamp latest
//   node scripts/backup-openmausbot-cloud.mjs restore --stamp latest --target ~/.openmausbot
//   node scripts/backup-openmausbot-cloud.mjs install-launchd
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const DEFAULT_DATA = process.env.OMB_USER_DATA ?? join(home, ".openmausbot");
const DEFAULT_COMPANION = join(home, ".openmausbot-companion");
const DEFAULT_REMOTE_ROOT = process.env.OMB_CLOUD_BACKUP_REMOTE ?? "gdrive_supermemory:OpenMausBot/backups";
const DEFAULT_LOCAL_ROOT = join(home, "Backups", "openmausbot-cloud");
const DEFAULT_RETENTION = process.env.OMB_CLOUD_BACKUP_RETENTION ?? "60d";
const DEFAULT_LOCAL_KEEP = Number(process.env.OMB_CLOUD_BACKUP_LOCAL_KEEP ?? 14);
const LOCK = join(tmpdir(), "openmausbot-cloud-backup.lockdir");
const RCLONE = process.env.RCLONE ?? "/opt/homebrew/bin/rclone";
const REMOTE_DATA = {
  data: "/var/lib/openmausbot",
  companion: "/var/lib/openmausbot-companion",
};
const RSYNC_EXCLUDES = [
  "--exclude",
  "workspaces/**/node_modules",
  "--exclude",
  "omb-hosted/**",
  "--exclude",
  "*.db-shm",
  "--exclude",
  "*.db-wal",
];

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "backup";
const flags = new Set(args.filter((a) => a.startsWith("--")));
const opt = (name) => args.find((a, i) => args[i - 1] === `--${name}`);
const dryRun = flags.has("--dry-run");
const withCompanion = !flags.has("--no-companion");
const sourceHost = opt("source-host");
const hostLabel = opt("host-label") ?? sourceHost ?? "local";
let dataDir = opt("data-dir") ?? DEFAULT_DATA;
let companionDir = opt("companion-dir") ?? DEFAULT_COMPANION;
const remoteRoot = `${DEFAULT_REMOTE_ROOT.replace(/\/$/, "")}/${hostLabel}`;
const localRoot = opt("local-root") ?? DEFAULT_LOCAL_ROOT;
const retention = opt("retention") ?? DEFAULT_RETENTION;
const restoreTarget = opt("target") ?? DEFAULT_DATA;

function run(cmd, cmdArgs, inherit = true) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun) return { status: 0, stdout: "" };
  const result = spawnSync(cmd, cmdArgs, { stdio: inherit ? "inherit" : "pipe", encoding: "utf8" });
  return result;
}

function runCapture(cmd, cmdArgs) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun) return "";
  return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
}

function runCaptureSafe(cmd, cmdArgs) {
  try {
    return runCapture(cmd, cmdArgs);
  } catch {
    return "";
  }
}

function rclonePath() {
  if (existsSync(RCLONE)) return RCLONE;
  const found = runCaptureSafe("command", ["-v", "rclone"]);
  return found || "rclone";
}

function acquireLock() {
  if (dryRun) return;
  try {
    mkdirSync(LOCK);
  } catch {
    console.error("backup already running");
    process.exit(0);
  }
}

function releaseLock() {
  if (dryRun) return;
  try {
    rmSync(LOCK, { recursive: true, force: true });
  } catch {}
}

function checkpointMessages(dir) {
  const db = join(dir, "messages.db");
  if (!existsSync(db)) return;
  try {
    runCapture("sqlite3", [db, "PRAGMA wal_checkpoint(FULL);"]);
  } catch (error) {
    console.warn(`wal checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readBots(dataPath) {
  const path = join(dataPath, "bots.json");
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(raw) ? raw : raw.bots ?? [];
}

function hierarchySummary(bots) {
  const visible = bots.filter((b) => !b.hidden);
  const chief = visible.find((b) => b.chiefOfStaff) ?? visible[0];
  const rootId = chief?.id ?? "";
  const included = new Set();
  const rows = [];

  const childrenOf = (parentId) =>
    visible.filter(
      (b) =>
        !included.has(b.id) &&
        b.id !== rootId &&
        (b.reportsToBotId === parentId || (parentId === rootId && !b.reportsToBotId)),
    );

  const walk = (parentId, depth) => {
    for (const kid of childrenOf(parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      included.add(kid.id);
      rows.push({
        id: kid.id,
        name: kid.name,
        title: kid.title ?? null,
        section: kid.section ?? null,
        reportsToBotId: kid.reportsToBotId ?? null,
        depth,
      });
      walk(kid.id, depth + 1);
    }
  };

  if (rootId) walk(rootId, 0);
  for (const orphan of visible.filter((b) => !included.has(b.id) && b.id !== rootId).sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push({
      id: orphan.id,
      name: orphan.name,
      title: orphan.title ?? null,
      section: orphan.section ?? null,
      reportsToBotId: orphan.reportsToBotId ?? null,
      depth: 0,
    });
  }

  return {
    chiefBotId: rootId || null,
    chiefBotName: chief?.name ?? null,
    tree: rows,
  };
}

function messageCount(dataPath) {
  const db = join(dataPath, "messages.db");
  if (!existsSync(db)) return 0;
  try {
    return Number(runCapture("sqlite3", [db, "select count(*) from messages;"]));
  } catch {
    return 0;
  }
}

function listDataFiles(dataPath) {
  if (!existsSync(dataPath)) return [];
  const names = [];
  for (const name of readdirSync(dataPath)) {
    const full = join(dataPath, name);
    if (statSync(full).isFile()) names.push(name);
  }
  return names.sort();
}

export function buildManifest({ dataPath, companionPath, host, stamp, includeCompanion, hostLabel: label }) {
  const bots = readBots(dataPath);
  return {
    schema: "openmausbot-cloud-backup/v1",
    createdAtUtc: stamp,
    sourceHost: host,
    hostLabel: label,
    dataDir: dataPath,
    companionDir: includeCompanion && existsSync(companionPath) ? companionPath : null,
    botCount: bots.length,
    messageCount: messageCount(dataPath),
    bots: bots.map((b) => ({
      id: b.id,
      name: b.name,
      title: b.title ?? null,
      section: b.section ?? null,
      reportsToBotId: b.reportsToBotId ?? null,
      chiefOfStaff: Boolean(b.chiefOfStaff),
      hidden: Boolean(b.hidden),
      fastMode: Boolean(b.fastMode),
    })),
    hierarchy: hierarchySummary(bots),
    dataFiles: listDataFiles(dataPath),
    restoreHint: "bun run sync:data restore --from-cloud latest",
    cloudRestoreHint: "node scripts/backup-openmausbot-cloud.mjs restore --stamp latest",
  };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function stageSnapshot({ dataPath, companionPath, workDir, includeCompanion }) {
  mkdirSync(workDir, { recursive: true });
  cpSync(dataPath, join(workDir, "openmausbot"), {
    recursive: true,
    force: true,
    filter: (src) => {
      const base = basename(src);
      if (base === "node_modules") return false;
      if (src.includes("omb-hosted")) return false;
      if (base.endsWith(".db-shm") || base.endsWith(".db-wal")) return false;
      return true;
    },
  });
  if (includeCompanion && existsSync(companionPath)) {
    cpSync(companionPath, join(workDir, "openmausbot-companion"), { recursive: true, force: true });
  }
  return workDir;
}

function syncRemoteSource(host) {
  const staging = join(localRoot, ".staging", host);
  const stagedData = join(staging, "openmausbot");
  const stagedCompanion = join(staging, "openmausbot-companion");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(stagedData, { recursive: true });
  run("rsync", ["-az", ...RSYNC_EXCLUDES, `${host}:${REMOTE_DATA.data}/`, `${stagedData}/`]);
  if (withCompanion) {
    mkdirSync(stagedCompanion, { recursive: true });
    run("rsync", ["-az", `${host}:${REMOTE_DATA.companion}/`, `${stagedCompanion}/`]);
  }
  checkpointMessages(stagedData);
  dataDir = stagedData;
  companionDir = stagedCompanion;
  console.log(`staged remote ${host} → ${staging}`);
}

async function tarDirectory(sourceDir, archivePath) {
  const parent = dirname(sourceDir);
  const name = basename(sourceDir);
  run("tar", ["-C", parent, "-czf", archivePath, name]);
}

function pruneLocalArchives(dir, keep) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".tar.gz"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(keep)) {
    rmSync(join(dir, old.f), { force: true });
    rmSync(join(dir, `${old.f}.sha256`), { force: true });
  }
}

async function backup() {
  if (sourceHost) syncRemoteSource(sourceHost);
  if (!existsSync(dataDir)) throw new Error(`missing data dir: ${dataDir}`);
  acquireLock();
  try {
    checkpointMessages(dataDir);
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const dayPath = stamp.slice(0, 10).replace(/-/g, "/");
    const shortStamp = stamp.replace(/[-:]/g, "").slice(0, 15);
    const host = sourceHost ? `${sourceHost} (via ${runCaptureSafe("hostname", []) || "local"})` : runCaptureSafe("hostname", []) || hostLabel;
    const bundleDir = join(localRoot, ".work", `openmausbot-${shortStamp}`);
    const archiveName = `openmausbot-${shortStamp}.tar.gz`;
    const localDaily = join(localRoot, "daily", hostLabel, dayPath);
    const archivePath = join(localDaily, archiveName);
    const shaPath = `${archivePath}.sha256`;

    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(localDaily, { recursive: true });
    stageSnapshot({ dataPath: dataDir, companionPath: companionDir, workDir: bundleDir, includeCompanion: withCompanion });
    const manifest = buildManifest({
      dataPath: dataDir,
      companionPath: companionDir,
      host,
      stamp,
      includeCompanion: withCompanion,
      hostLabel,
    });
    writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(bundleDir, "MANIFEST.txt"),
      [
        `OpenMausBot cloud backup ${stamp}`,
        `host: ${host}`,
        `label: ${hostLabel}`,
        `bots: ${manifest.botCount}`,
        `messages: ${manifest.messageCount}`,
        `chief: ${manifest.hierarchy.chiefBotName ?? "n/a"}`,
        "",
        manifest.restoreHint,
        manifest.cloudRestoreHint,
        "",
      ].join("\n"),
    );
    chmodSync(join(bundleDir, "manifest.json"), 0o600);
    chmodSync(join(bundleDir, "MANIFEST.txt"), 0o600);

    if (!dryRun) {
      await tarDirectory(bundleDir, archivePath);
      const digest = await sha256File(archivePath);
      writeFileSync(shaPath, `${digest}  ${archiveName}\n`);
      rmSync(bundleDir, { recursive: true, force: true });
    } else {
      console.log(`would archive ${bundleDir} → ${archivePath}`);
    }

    const rclone = rclonePath();
    const remoteDaily = `${remoteRoot}/daily/${dayPath}`;
    const remoteLatest = `${remoteRoot}/latest`;
    if (!dryRun) {
      run(rclone, [
        "copy",
        localDaily,
        remoteDaily,
        "--filter",
        `+ ${archiveName}`,
        "--filter",
        `+ ${archiveName}.sha256`,
        "--filter",
        "- *",
        "--transfers",
        "1",
        "--checkers",
        "2",
        "--tpslimit",
        "3",
        "--tpslimit-burst",
        "3",
        "--drive-chunk-size",
        "16M",
      ]);
      run(rclone, ["copyto", archivePath, `${remoteLatest}/openmausbot-latest.tar.gz`]);
      run(rclone, ["copyto", shaPath, `${remoteLatest}/openmausbot-latest.tar.gz.sha256`]);
      const manifestTmp = join(localRoot, ".work", "manifest-upload.json");
      mkdirSync(dirname(manifestTmp), { recursive: true });
      writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
      run(rclone, ["copyto", manifestTmp, `${remoteLatest}/manifest.json`]);
      run(rclone, ["delete", `${remoteRoot}/daily`, "--min-age", retention, "--rmdirs"], false);
      pruneLocalArchives(localDaily, DEFAULT_LOCAL_KEEP);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          stamp,
          hostLabel,
          archive: archivePath,
          remoteDaily,
          remoteLatest,
          bots: manifest.botCount,
          messages: manifest.messageCount,
          hierarchyNodes: manifest.hierarchy.tree.length,
        },
        null,
        2,
      ),
    );
  } finally {
    releaseLock();
  }
}

function listRemote() {
  const rclone = rclonePath();
  const label = opt("host-label") ?? hostLabel;
  run(rclone, ["lsf", `${DEFAULT_REMOTE_ROOT.replace(/\/$/, "")}/${label}/daily`, "--recursive", "--format", "pt"]);
}

function pull() {
  const stamp = opt("stamp") ?? "latest";
  const label = opt("host-label") ?? hostLabel;
  const outRoot = opt("out") ?? join(localRoot, "pulled", label);
  mkdirSync(outRoot, { recursive: true });
  const rclone = rclonePath();
  const remoteLatest = `${DEFAULT_REMOTE_ROOT.replace(/\/$/, "")}/${label}/latest`;

  if (stamp === "latest") {
    const archive = join(outRoot, "openmausbot-latest.tar.gz");
    const sha = `${archive}.sha256`;
    run(rclone, ["copyto", `${remoteLatest}/openmausbot-latest.tar.gz`, archive]);
    run(rclone, ["copyto", `${remoteLatest}/openmausbot-latest.tar.gz.sha256`, sha]);
    run(rclone, ["copyto", `${remoteLatest}/manifest.json`, join(outRoot, "manifest.json")]);
    console.log(`pulled latest → ${archive}`);
    return archive;
  }

  const remoteDailyRoot = `${DEFAULT_REMOTE_ROOT.replace(/\/$/, "")}/${label}/daily`;
  const matches = runCapture(rclone, ["lsf", remoteDailyRoot, "--recursive"])
    .split("\n")
    .filter((line) => line.includes(stamp) && line.endsWith(".tar.gz"));
  if (!matches.length) throw new Error(`no remote backup matching ${stamp}`);
  const remotePath = `${remoteDailyRoot}/${matches.at(-1)}`;
  const localPath = join(outRoot, basename(remotePath));
  run(rclone, ["copyto", remotePath, localPath]);
  console.log(`pulled ${remotePath} → ${localPath}`);
  return localPath;
}

function extractArchive(archivePath, outDir) {
  mkdirSync(outDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", outDir]);
  return outDir;
}

function findBackupRoot(extractedDir) {
  const direct = join(extractedDir, "openmausbot");
  if (existsSync(direct)) return extractedDir;
  for (const name of readdirSync(extractedDir)) {
    const candidate = join(extractedDir, name);
    if (!statSync(candidate).isDirectory()) continue;
    if (existsSync(join(candidate, "openmausbot"))) return candidate;
  }
  throw new Error(`no openmausbot directory under ${extractedDir}`);
}

function restoreFromArchive(archivePath, targetDataDir) {
  const extracted = join(dirname(archivePath), "extracted", basename(archivePath, ".tar.gz"));
  rmSync(extracted, { recursive: true, force: true });
  extractArchive(archivePath, extracted);
  const rootDir = findBackupRoot(extracted);
  const resolvedSrc = join(rootDir, "openmausbot");
  const preRestore = `${targetDataDir}.pre-restore`;
  if (existsSync(targetDataDir) && !dryRun) {
    cpSync(targetDataDir, preRestore, { recursive: true, force: true });
    console.log(`saved previous data → ${preRestore}`);
  }
  mkdirSync(targetDataDir, { recursive: true });
  cpSync(resolvedSrc, targetDataDir, { recursive: true, force: true });
  const companionSrc = join(rootDir, "openmausbot-companion");
  if (existsSync(companionSrc)) {
    cpSync(companionSrc, DEFAULT_COMPANION, { recursive: true, force: true });
  }
  summarizeRestore(resolvedSrc);
  console.log(`restore done → ${targetDataDir}`);
}

function summarizeRestore(dataPath) {
  const bots = readBots(dataPath);
  console.log(`  bots: ${bots.length} (${bots.map((b) => b.name).join(", ")})`);
  console.log(`  messages.db rows: ${messageCount(dataPath)}`);
}

function restoreCloud() {
  const stamp = opt("stamp") ?? "latest";
  const label = opt("host-label") ?? "servarica";
  const archive = pullWithLabel(stamp, label);
  restoreFromArchive(archive, restoreTarget);
}

function pullWithLabel(stamp, label) {
  const outRoot = join(localRoot, "pulled", label);
  mkdirSync(outRoot, { recursive: true });
  const rclone = rclonePath();
  const remoteLatest = `${DEFAULT_REMOTE_ROOT.replace(/\/$/, "")}/${label}/latest`;
  if (stamp === "latest") {
    const archive = join(outRoot, "openmausbot-latest.tar.gz");
    run(rclone, ["copyto", `${remoteLatest}/openmausbot-latest.tar.gz`, archive]);
    run(rclone, ["copyto", `${remoteLatest}/openmausbot-latest.tar.gz.sha256`, `${archive}.sha256`]);
    run(rclone, ["copyto", `${remoteLatest}/manifest.json`, join(outRoot, "manifest.json")]);
    return archive;
  }
  const remoteDailyRoot = `${DEFAULT_REMOTE_ROOT.replace(/\/$/, "")}/${label}/daily`;
  const matches = runCapture(rclone, ["lsf", remoteDailyRoot, "--recursive"])
    .split("\n")
    .filter((line) => line.includes(stamp) && line.endsWith(".tar.gz"));
  if (!matches.length) throw new Error(`no remote backup matching ${stamp}`);
  const remotePath = `${remoteDailyRoot}/${matches.at(-1)}`;
  const localPath = join(outRoot, basename(remotePath));
  run(rclone, ["copyto", remotePath, localPath]);
  return localPath;
}

function installLaunchd() {
  const node = existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
  const script = join(root, "scripts", "backup-openmausbot-cloud.mjs");
  const logsDir = join(home, "Library", "Logs", "OpenMausBotHostedCompanion");
  mkdirSync(logsDir, { recursive: true });
  const dest = join(home, "Library", "LaunchAgents", "com.posival.openmaus-cloud-backup.plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.posival.openmaus-cloud-backup</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string>
    <string>${script}</string>
    <string>--source-host</string><string>servarica</string>
    <string>--host-label</string><string>servarica</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
  <key>StandardOutPath</key><string>${join(logsDir, "cloud-backup.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(logsDir, "cloud-backup.err.log")}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${home}</string>
    <key>OMB_CLOUD_BACKUP_REMOTE</key><string>${DEFAULT_REMOTE_ROOT}</string>
  </dict>
</dict></plist>`;
  writeFileSync(dest, plist);
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, dest], { stdio: "pipe" });
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, dest]);
  console.log(`installed ${dest} (daily 03:15 — backs up servarica fleet to Drive)`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/backup-openmausbot-cloud.mjs [--source-host servarica] [--host-label NAME] [--dry-run]
  node scripts/backup-openmausbot-cloud.mjs list [--host-label servarica]
  node scripts/backup-openmausbot-cloud.mjs pull --stamp latest [--host-label servarica]
  node scripts/backup-openmausbot-cloud.mjs restore --stamp latest [--host-label servarica] [--target PATH]
  node scripts/backup-openmausbot-cloud.mjs install-launchd

Defaults:
  data dir     ${DEFAULT_DATA}
  remote root  ${DEFAULT_REMOTE_ROOT}/<host-label>
  retention    ${DEFAULT_RETENTION}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  switch (command) {
    case "backup":
      await backup();
      break;
    case "list":
      listRemote();
      break;
    case "pull":
      pull();
      break;
    case "restore":
      restoreCloud();
      break;
    case "install-launchd":
      installLaunchd();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}
