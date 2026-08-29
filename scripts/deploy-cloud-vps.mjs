#!/usr/bin/env node
// Deploy headless harness + companion + Cloudflare tunnel to a Linux VPS.
// Run from a dev machine with SSH access to the target host.
//
//   node scripts/deploy-cloud-vps.mjs
//   node scripts/deploy-cloud-vps.mjs --host servarica --cutover
//   node scripts/deploy-cloud-vps.mjs --skip-build --skip-migrate
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUDFLARED_ASSETS, CLOUDFLARED_VERSION } from "./prepare-cloudflared.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const linuxScripts = join(root, "scripts", "hosted-runtime", "linux");
const home = homedir();

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const hostArg = args.find((a, i) => args[i - 1] === "--host") ?? process.env.OMB_VPS_HOST ?? "servarica";
const skipBuild = flags.has("--skip-build");
const skipMigrate = flags.has("--skip-migrate");
const cutover = flags.has("--cutover");
const dryRun = flags.has("--dry-run");

const REMOTE = {
  root: "/opt/openmausbot",
  runtime: "/opt/openmausbot/runtime",
  data: "/var/lib/openmausbot",
  companion: "/var/lib/openmausbot-companion",
  etc: "/etc/openmausbot",
  logs: "/var/log/openmausbot",
};

const TUNNEL_ID = "6c606964-498a-4d65-b2d7-4736b5b81058";
const HOSTED_URL = "https://openmaus.posival.com";
const CHIEF_BOT_ID = "94a201dd-537d-40be-8da3-e723532c982b";
const DOCKER_SSH_ALIAS = "openmaus-docker";

const packageManager = spawnSync("command", ["-v", "pnpm"], { encoding: "utf8" }).status === 0 ? "pnpm" : "bun";

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun) return { status: 0, stdout: "" };
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", encoding: "utf8", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

function runCapture(cmd, cmdArgs) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  if (dryRun) return "";
  return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
}

function ssh(remoteCmd) {
  return runCapture("ssh", [hostArg, remoteCmd]);
}

function rsync(localPath, remotePath, extra = []) {
  run("rsync", ["-az", "--delete", ...extra, `${localPath}/`, `${hostArg}:${remotePath}/`]);
}

function runPackageScript(script) {
  if (packageManager === "pnpm") run("pnpm", [script], { cwd: root });
  else run("bun", ["run", script], { cwd: root });
}

function stageLinuxCloudflared(destDir) {
  const asset = CLOUDFLARED_ASSETS["linux-x64"];
  const staged = join(root, "dist-native", "cloudflared", "linux-x64", "cloudflared");
  if (existsSync(staged)) {
    copyFileSync(staged, join(destDir, "cloudflared"));
    chmodSync(join(destDir, "cloudflared"), 0o755);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
  console.log(`fetching cloudflared ${CLOUDFLARED_VERSION} for linux-x64…`);
  runCapture("curl", ["-fsSL", url, "-o", join(destDir, "cloudflared")]);
  const hash = createHash("sha256").update(readFileSync(join(destDir, "cloudflared"))).digest("hex");
  if (hash !== asset.binarySha256) throw new Error(`cloudflared hash mismatch: ${hash}`);
  chmodSync(join(destDir, "cloudflared"), 0o755);
}

function patchChiefCloud(stagingDir) {
  const botsPath = join(stagingDir, "bots.json");
  if (!existsSync(botsPath)) return;
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
  if (changed) {
    writeFileSync(botsPath, `${JSON.stringify(bots, null, 2)}\n`);
    console.log("patched Chief Keef → computer=cloud, cloudBackend=vps");
  }
}

function patchVpsConfig(stagingDir) {
  const configPath = join(stagingDir, "config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  config.vps = { sshAlias: DOCKER_SSH_ALIAS };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`patched config.json → vps.sshAlias=${DOCKER_SSH_ALIAS}`);
}

async function waitHarness(remote = false, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      let ok = false;
      if (remote) {
        const out = ssh(`curl -sf http://127.0.0.1:8799/api/health || true`);
        ok = out.includes("openmausbot");
      } else {
        const res = await fetch("http://127.0.0.1:8799/api/health");
        ok = res.ok;
      }
      if (ok) return;
    } catch {
      // retry
    }
    await sleep(1000);
  }
  throw new Error("harness did not become healthy in time");
}

function installRemoteNode() {
  ssh(`
set -euo pipefail
if command -v node >/dev/null 2>&1; then
  major=\$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "\$major" -ge 24 ]; then
    echo "node \$(node -v) ok"
  else
    echo "node too old: \$(node -v)"
    need_install=1
  fi
else
  need_install=1
fi
if [ "\${need_install:-0}" = "1" ]; then
  echo "installing Node.js 24…"
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
  node -v
fi
command -v docker >/dev/null || { echo "docker missing on VPS"; exit 1; }
mkdir -p ${REMOTE.logs} ${REMOTE.etc} ${REMOTE.data}/omb-hosted/omb-companion-origin-main ${REMOTE.companion}
`);
}

function installRemoteSshLocalDocker() {
  ssh(`
set -euo pipefail
KEY=${REMOTE.etc}/openmaus_local
AUTH=/root/.ssh/authorized_keys
CFG=/root/.ssh/config
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ ! -f "\$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -f "\$KEY" -C openmaus-local-docker
  grep -qF "\$(cat \$KEY.pub)" "\$AUTH" 2>/dev/null || cat \$KEY.pub >> "\$AUTH"
  chmod 600 "\$AUTH"
fi
cat > "\$CFG" <<EOF
Host ${DOCKER_SSH_ALIAS}
  HostName 127.0.0.1
  User root
  IdentityFile ${REMOTE.etc}/openmaus_local
  StrictHostKeyChecking accept-new
EOF
chmod 600 "\$CFG"
ssh -o BatchMode=yes ${DOCKER_SSH_ALIAS} true
docker -H ssh://${DOCKER_SSH_ALIAS} info >/dev/null
echo "local docker over ssh://${DOCKER_SSH_ALIAS} ok"
`);
}

function installSystemdUnits() {
  for (const unit of [
    "openmausbot-harness.service",
    "openmausbot-sidecar.service",
    "openmausbot-cloudflared.service",
  ]) {
    run("scp", [join(linuxScripts, unit), `${hostArg}:/etc/systemd/system/${unit}`]);
  }
  ssh(`
set -euo pipefail
systemctl daemon-reload
systemctl enable openmausbot-harness openmausbot-sidecar openmausbot-cloudflared
`);
}

function installCloudflaredConfig() {
  const credSrc = join(home, ".cloudflared", `${TUNNEL_ID}.json`);
  if (!existsSync(credSrc)) throw new Error(`missing tunnel credentials: ${credSrc}`);
  run("scp", [credSrc, `${hostArg}:${REMOTE.etc}/cloudflared-credentials.json`]);
  const yml = readFileSync(join(linuxScripts, "cloudflared.yml.template"), "utf8").replace("TUNNEL_ID", TUNNEL_ID);
  const localYml = join(root, ".deploy-staging", "cloudflared.yml");
  mkdirSync(dirname(localYml), { recursive: true });
  writeFileSync(localYml, yml);
  run("scp", [localYml, `${hostArg}:${REMOTE.etc}/cloudflared.yml`]);
  ssh(`chmod 600 ${REMOTE.etc}/cloudflared-credentials.json ${REMOTE.etc}/cloudflared.yml`);
}

function stopMiniTunnel() {
  console.log("stopping Mac mini hosted tunnel + sidecar (cutover)…");
  run("launchctl", ["bootout", `gui/${process.getuid()}`, join(home, "Library/LaunchAgents/com.posival.openmaus-hosted-cloudflared.plist")], {
    stdio: "pipe",
  });
  run("launchctl", ["bootout", `gui/${process.getuid()}`, join(home, "Library/LaunchAgents/com.posival.openmaus-hosted-sidecar.plist")], {
    stdio: "pipe",
  });
}

function restartRemoteServices() {
  ssh(`
set -euo pipefail
systemctl restart openmausbot-harness
sleep 2
systemctl restart openmausbot-sidecar
sleep 2
systemctl restart openmausbot-cloudflared
systemctl is-active openmausbot-harness openmausbot-sidecar openmausbot-cloudflared
`);
}

function verifyPublic() {
  const health = runCapture("curl", ["-sf", "-o", "/dev/null", "-w", "%{http_code}", `${HOSTED_URL}/api/health`]);
  console.log(`public ${HOSTED_URL}/api/health → HTTP ${health}`);
  if (health !== "200") throw new Error("public health check failed");
  const unauth = runCapture("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${HOSTED_URL}/api/bots`]);
  console.log(`public ${HOSTED_URL}/api/bots (no token) → HTTP ${unauth}`);
  if (unauth !== "401") throw new Error(`expected 401 without bearer token, got ${unauth}`);
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(`deploy-cloud-vps → ${hostArg}${cutover ? " (cutover)" : ""}`);

if (!skipBuild) {
  runPackageScript("build:server");
  runPackageScript("build:companion");
}

const staging = join(root, ".deploy-staging", "runtime");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(join(root, "dist-server"), join(staging, "server"), { recursive: true });
cpSync(join(root, "dist-companion"), join(staging, "companion"), { recursive: true });
cpSync(join(root, "skills"), join(staging, "resources", "skills"), { recursive: true });
mkdirSync(join(staging, "resources"), { recursive: true });
for (const script of ["start-harness.sh", "start-sidecar.sh"]) {
  copyFileSync(join(linuxScripts, script), join(staging, script));
  chmodSync(join(staging, script), 0o755);
}
stageLinuxCloudflared(staging);

installRemoteNode();
ssh(`mkdir -p ${REMOTE.runtime}`);
rsync(staging, REMOTE.runtime);

if (!skipMigrate) {
  const dataStaging = join(root, ".deploy-staging", "data");
  rmSync(dataStaging, { recursive: true, force: true });
  mkdirSync(dataStaging, { recursive: true });
  cpSync(join(home, ".openmausbot"), dataStaging, { recursive: true });
  patchChiefCloud(dataStaging);
  patchVpsConfig(dataStaging);
  rsync(dataStaging, REMOTE.data, ["--exclude", "workspaces/**/node_modules"]);

  if (existsSync(join(home, ".openmausbot-companion"))) {
    rsync(join(home, ".openmausbot-companion"), REMOTE.companion);
  }
}

installRemoteSshLocalDocker();
installCloudflaredConfig();
installSystemdUnits();

if (cutover) stopMiniTunnel();
restartRemoteServices();
ssh("sleep 3 && curl -sf http://127.0.0.1:8799/api/health | head -c 200");
if (cutover) verifyPublic();

console.log(`
done — cloud harness on ${hostArg}
  harness: 127.0.0.1:8799 (remote)
  sidecar socket: ${REMOTE.data}/omb-hosted/omb-companion-origin-main/origin.sock
  public: ${HOSTED_URL}
  vps docker: ssh://${DOCKER_SSH_ALIAS} (local docker on VPS)
  logs: ${REMOTE.logs}/
  control: ssh ${hostArg} 'curl -sf http://127.0.0.1:28811/pairing'  # start pairing

Phone: no re-pair needed if devices.json migrated. Chief is cloud/VPS on this host.
Mini harness (launchd) still runs for Local VM bridge until you disable it separately.
`);
