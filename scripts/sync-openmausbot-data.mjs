#!/usr/bin/env node
// Sync or backup OpenMausBot workspace data (bots, transcripts, workspaces).
//
//   node scripts/sync-openmausbot-data.mjs push --host servarica
//   node scripts/sync-openmausbot-data.mjs pull --host servarica
//   node scripts/sync-openmausbot-data.mjs backup
//   node scripts/sync-openmausbot-data.mjs push --host servarica --companion --restart
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const LOCAL_DATA = join(home, ".openmausbot");
const LOCAL_COMPANION = join(home, ".openmausbot-companion");
const CHIEF_BOT_ID = "94a201dd-537d-40be-8da3-e723532c982b";
const DOCKER_SSH_ALIAS = "openmaus-docker";

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.filter((a) => a.startsWith("--")));
const host = args.find((a, i) => args[i - 1] === "--host") ?? "servarica";
const withCompanion = flags.has("--companion");
const restart = flags.has("--restart");
const dryRun = flags.has("--dry-run");

const REMOTE = {
  data: "/var/lib/openmausbot",
  companion: "/var/lib/openmausbot-companion",
};

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun) return { status: 0, stdout: "" };
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", encoding: "utf8", ...opts });
}

function runCapture(cmd, cmdArgs) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun) return "";
  return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
}

function rsync(localPath, remotePath, extra = []) {
  run("rsync", ["-az", ...extra, `${localPath}/`, `${host}:${remotePath}/`]);
}

function checkpointMessages(dataDir) {
  const db = join(dataDir, "messages.db");
  if (!existsSync(db)) return;
  try {
    runCapture("sqlite3", [db, "PRAGMA wal_checkpoint(FULL);"]);
  } catch (error) {
    console.warn(`wal checkpoint skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function patchCloudStaging(stagingDir) {
  const botsPath = join(stagingDir, "bots.json");
  if (existsSync(botsPath)) {
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    let changed = false;
    for (const bot of bots) {
      if (bot.id !== CHIEF_BOT_ID) continue;
      if (bot.computer !== "cloud") {
        bot.computer = "cloud";
        changed = true;
      }
      if (bot.cloudBackend !== "vps") {
        bot.cloudBackend = "vps";
        changed = true;
      }
    }
    if (changed) writeFileSync(botsPath, `${JSON.stringify(bots, null, 2)}\n`);
  }
  const configPath = join(stagingDir, "config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  config.vps = { sshAlias: DOCKER_SSH_ALIAS };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function stageLocalData() {
  const staging = join(root, ".deploy-staging", "data-sync");
  cpSync(LOCAL_DATA, staging, { recursive: true, force: true });
  checkpointMessages(staging);
  patchCloudStaging(staging);
  return staging;
}

function summarize(dataDir) {
  const bots = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
  const list = Array.isArray(bots) ? bots : bots.bots ?? [];
  let messages = 0;
  const db = join(dataDir, "messages.db");
  if (existsSync(db)) {
    try {
      messages = Number(runCapture("python3", [
        "-c",
        `import sqlite3; print(sqlite3.connect(${JSON.stringify(db)}).execute('select count(*) from messages').fetchone()[0])`,
      ]));
    } catch {}
  }
  console.log(`  bots: ${list.length} (${list.map((b) => b.name).join(", ")})`);
  console.log(`  messages.db rows: ${messages}`);
}

function push() {
  if (!existsSync(LOCAL_DATA)) throw new Error(`missing ${LOCAL_DATA}`);
  console.log(`push ${LOCAL_DATA} → ${host}:${REMOTE.data}`);
  summarize(LOCAL_DATA);
  checkpointMessages(LOCAL_DATA);
  const staging = stageLocalData();
  rsync(staging, REMOTE.data, ["--exclude", "workspaces/**/node_modules", "--exclude", "omb-hosted/**"]);
  if (withCompanion && existsSync(LOCAL_COMPANION)) {
    console.log(`push ${LOCAL_COMPANION} → ${host}:${REMOTE.companion}`);
    rsync(LOCAL_COMPANION, REMOTE.companion);
  }
  if (restart) {
    runCapture("ssh", [
      host,
      "systemctl restart openmausbot-harness openmausbot-sidecar && sleep 2 && curl -sf http://127.0.0.1:8799/api/health | head -c 120",
    ]);
  }
  console.log("push done");
}

function pull() {
  console.log(`pull ${host}:${REMOTE.data} → ${LOCAL_DATA}`);
  mkdirSync(LOCAL_DATA, { recursive: true });
  run("rsync", ["-az", `${host}:${REMOTE.data}/`, `${LOCAL_DATA}/`]);
  if (withCompanion) {
    mkdirSync(LOCAL_COMPANION, { recursive: true });
    run("rsync", ["-az", `${host}:${REMOTE.companion}/`, `${LOCAL_COMPANION}/`]);
  }
  summarize(LOCAL_DATA);
  console.log("pull done — restart local harness if you switch back to mini");
}

function backup() {
  if (!existsSync(LOCAL_DATA)) throw new Error(`missing ${LOCAL_DATA}`);
  checkpointMessages(LOCAL_DATA);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = join(home, "Backups", "openmausbot", stamp);
  mkdirSync(dest, { recursive: true });
  cpSync(LOCAL_DATA, join(dest, "openmausbot"), { recursive: true });
  if (existsSync(LOCAL_COMPANION)) {
    cpSync(LOCAL_COMPANION, join(dest, "openmausbot-companion"), { recursive: true });
  }
  const manifest = join(dest, "MANIFEST.txt");
  writeFileSync(
    manifest,
    `OpenMausBot backup ${stamp}\nhost: ${runCapture("hostname", [])}\nrestore: node scripts/sync-openmausbot-data.mjs restore --from ${dest}\n`,
  );
  chmodSync(manifest, 0o600);
  summarize(join(dest, "openmausbot"));
  console.log(`backup → ${dest}`);
}

function restoreFromCloud(stamp = "latest") {
  const label = args.find((a, i) => args[i - 1] === "--host-label") ?? "servarica";
  const backupScript = join(root, "scripts", "backup-openmausbot-cloud.mjs");
  run("node", [backupScript, "restore", "--stamp", stamp, "--host-label", label]);
}

function restoreInner(from, src) {
  const backupFirst = join(home, ".openmausbot.pre-restore");
  if (existsSync(LOCAL_DATA) && !dryRun) {
    cpSync(LOCAL_DATA, backupFirst, { recursive: true, force: true });
    console.log(`saved previous data → ${backupFirst}`);
  }
  cpSync(src, LOCAL_DATA, { recursive: true, force: true });
  const companionSrc = join(from, "openmausbot-companion");
  if (existsSync(companionSrc)) cpSync(companionSrc, LOCAL_COMPANION, { recursive: true, force: true });
  summarize(LOCAL_DATA);
  console.log("restore done — restart harness on the target host");
}

function restore() {
  const cloudIdx = args.indexOf("--from-cloud");
  if (cloudIdx !== -1) {
    restoreFromCloud(args[cloudIdx + 1] ?? "latest");
    return;
  }
  const from = args.find((a, i) => args[i - 1] === "--from");
  if (!from) throw new Error("restore needs --from /path/to/backup or --from-cloud [latest|stamp]");
  const src = join(from, "openmausbot");
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  restoreInner(from, src);
}

switch (command) {
  case "push":
    push();
    break;
  case "pull":
    pull();
    break;
  case "backup":
    backup();
    break;
  case "restore":
    restore();
    break;
  default:
    console.log(`Usage:
  node scripts/sync-openmausbot-data.mjs push --host servarica [--companion] [--restart]
  node scripts/sync-openmausbot-data.mjs pull --host servarica [--companion]
  node scripts/sync-openmausbot-data.mjs backup
  node scripts/sync-openmausbot-data.mjs restore --from ~/Backups/openmausbot/<stamp>
  node scripts/sync-openmausbot-data.mjs restore --from-cloud latest [--host-label servarica]`);
    process.exit(command ? 1 : 0);
}
