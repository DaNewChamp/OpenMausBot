#!/usr/bin/env node
// Deploy headless harness + companion to the Mac mini hosted runtime.
// Replaces reliance on OpenMausBot.app for :8799 and VM image prep.
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = join(root, "scripts", "hosted-runtime");
const home = homedir();
const runtimeRoot = join(home, "Library", "Application Support", "OpenMausBotHostedCompanion", "runtime");
const resourcesRoot = join(runtimeRoot, "resources");
const launchAgents = join(home, "Library", "LaunchAgents");
const logsDir = join(home, "Library", "Logs", "OpenMausBotHostedCompanion");
const packagedApp = "/Applications/OpenMausBot.app/Contents/Resources";
const layerMarker = join(runtimeRoot, "vm-image-layer.txt");
const harnessPort = Number(process.env.OMB_PORT ?? 8799);

const flags = new Set(process.argv.slice(2));
const skipBuild = flags.has("--skip-build");
const skipSwitch = flags.has("--skip-switch");
const forcePull = flags.has("--pull-vm");
const recreateVm = flags.has("--recreate-vm");

const packageManager = process.env.OMB_PACKAGE_MANAGER ?? (spawnSync("command", ["-v", "pnpm"], { encoding: "utf8" }).status === 0 ? "pnpm" : "bun");

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPackageScript(script) {
  if (packageManager === "pnpm") run("pnpm", [script], { cwd: root });
  else run("bun", ["run", script], { cwd: root });
}

function readImageLayerVersion() {
  const source = readFileSync(join(root, "server", "container-computer.ts"), "utf8");
  const match = source.match(/export const IMAGE_LAYER_VERSION = "(\d+)"/);
  if (!match) throw new Error("could not read IMAGE_LAYER_VERSION from container-computer.ts");
  return match[1];
}

function syncTree(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function linkOrCopy(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(src)) symlinkSync(src, dest);
  else console.warn(`warn: missing optional resource ${src}`);
}

function installLaunchAgent(label, plistName) {
  const src = join(scripts, plistName);
  const dest = join(launchAgents, plistName);
  copyFileSync(src, dest);
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, dest], { stdio: "pipe" });
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, dest]);
  console.log(`launchd: ${label} loaded`);
}

function portOwner(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
    if (!out) return null;
    const pid = Number(out.split("\n")[0]);
    const name = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
    return { pid, name };
  } catch {
    return null;
  }
}

async function waitHarnessReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${harnessPort}/api/local-computer`, {
        headers: { host: `127.0.0.1:${harnessPort}` },
      });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`harness did not answer on :${harnessPort} within ${timeoutMs}ms`);
}

async function harnessPost(path, timeoutMs = 20 * 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${harnessPort}${path}`, {
      method: "POST",
      headers: {
        host: `127.0.0.1:${harnessPort}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) throw new Error(`${path} failed (${res.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function quitDesktopHarness() {
  const owner = portOwner(harnessPort);
  if (!owner) return;
  if (/OpenMausBot/i.test(owner.name)) {
    console.log(`quitting OpenMausBot.app (pid ${owner.pid}) to free :${harnessPort}`);
    run("osascript", ["-e", 'tell application "OpenMausBot" to quit']);
    for (let i = 0; i < 40; i++) {
      if (!portOwner(harnessPort)) return;
      await sleep(500);
    }
    throw new Error("OpenMausBot.app did not release the harness port");
  }
  if (/node/i.test(owner.name)) {
    console.log(`harness already running as node pid ${owner.pid}`);
    return;
  }
  throw new Error(`unexpected listener on :${harnessPort}: ${owner.name} (${owner.pid})`);
}

mkdirSync(logsDir, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

if (!skipBuild) {
  runPackageScript("build:server");
  runPackageScript("build:companion");
}

syncTree(join(root, "dist-server"), join(runtimeRoot, "server"));
syncTree(join(root, "dist-companion"), join(runtimeRoot, "companion"));
syncTree(join(root, "skills"), join(resourcesRoot, "skills"));
linkOrCopy(join(packagedApp, "android-platform-tools"), join(resourcesRoot, "android-platform-tools"));
linkOrCopy(join(packagedApp, "cua-driver"), join(resourcesRoot, "cua-driver"));

const startHarness = join(runtimeRoot, "start-harness.sh");
copyFileSync(join(scripts, "start-harness.sh"), startHarness);
chmodSync(startHarness, 0o755);

const startSidecar = join(runtimeRoot, "start-sidecar.sh");
if (!existsSync(startSidecar)) {
  writeFileSync(
    startSidecar,
    `#!/bin/zsh
set -euo pipefail
SOCK="${home}/.omb-hosted/omb-companion-origin-main/origin.sock"
rm -f "$SOCK"
exec /opt/homebrew/bin/node "${runtimeRoot}/companion/index.js"
`,
  );
  chmodSync(startSidecar, 0o755);
}

const imageLayer = readImageLayerVersion();
const previousLayer = existsSync(layerMarker) ? readFileSync(layerMarker, "utf8").trim() : "";
console.log(`deployed runtime → ${runtimeRoot} (vm image layer v${imageLayer})`);

installLaunchAgent("com.posival.openmaus-harness", "com.posival.openmaus-harness.plist");

if (!skipSwitch) {
  await quitDesktopHarness();
  run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.posival.openmaus-harness`]);
}

run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.posival.openmaus-hosted-sidecar`]);

await waitHarnessReady();

const shouldPull = forcePull || previousLayer !== imageLayer;
if (shouldPull) {
  console.log(`building Local VM image layer v${imageLayer} (docker pull/build — may take several minutes)…`);
  const status = await harnessPost("/api/local-computer/pull", 30 * 60_000);
  writeFileSync(layerMarker, `${imageLayer}\n`);
  console.log("vm image ready:", status.image ?? status);
} else {
  console.log(`vm image layer unchanged (v${imageLayer}); skip pull (pass --pull-vm to force)`);
}

if (recreateVm) {
  console.log("recreating Local VM from new image…");
  const status = await harnessPost("/api/local-computer/remove", 5 * 60_000).catch(() => null);
  if (status) console.log("removed:", status.container ?? status);
  const runStatus = await harnessPost("/api/local-computer/run", 5 * 60_000);
  console.log("vm running:", runStatus.container ?? runStatus);
}

console.log("done — headless harness on 127.0.0.1:%s, sidecar kickstarted", harnessPort);
