#!/usr/bin/env node
// Install the OpenMausBot bridge daemon on this machine (Mac mini, Pi, etc.)
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const runtimeRoot = join(home, ".openmausbot-bridge", "runtime");
const launchAgents = join(home, "Library", "LaunchAgents");
const logsDir = join(home, "Library", "Logs", "OpenMausBotBridge");
const hostedUrl = process.env.OMB_BRIDGE_URL ?? "https://openmaus.posival.com";
const bridgeName = process.env.OMB_BRIDGE_NAME ?? hostname();
const bridgeEnv = [
  ["OMB_BRIDGE_SHELL", process.env.OMB_BRIDGE_SHELL],
  ["OMB_BRIDGE_LOCAL_VM", process.env.OMB_BRIDGE_LOCAL_VM],
  ["OMB_BRIDGE_SSH_FORWARD", process.env.OMB_BRIDGE_SSH_FORWARD],
].filter(([, v]) => v === "1" || v === "true");

const flags = new Set(process.argv.slice(2));
const skipBuild = flags.has("--skip-build");
const pairOnly = flags.has("--pair");

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

mkdirSync(logsDir, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });

if (!skipBuild) {
  if (spawnSync("command", ["-v", "pnpm"], { encoding: "utf8" }).status === 0) run("pnpm", ["build:bridge"], { cwd: root });
  else run("bun", ["run", "build:bridge"], { cwd: root });
}

cpSync(join(root, "dist-bridge"), join(runtimeRoot, "bridge"), { recursive: true });

const startScript = join(runtimeRoot, "start-bridge.sh");
writeExecutable(
  startScript,
  `#!/bin/zsh
set -euo pipefail
NODE="$(command -v node)"
exec "$NODE" "${runtimeRoot}/bridge/index.js" run
`,
);

const plistPath = join(launchAgents, "com.posival.openmaus-bridge.plist");
const envPlist =
  bridgeEnv.length === 0
    ? ""
    : `  <key>EnvironmentVariables</key><dict>${bridgeEnv.map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>\n`;
writeFileSync(
  plistPath,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.posival.openmaus-bridge</string>
  <key>ProgramArguments</key><array><string>${startScript}</string></array>
${envPlist}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logsDir}/bridge.out.log</string>
  <key>StandardErrorPath</key><string>${logsDir}/bridge.err.log</string>
</dict></plist>`,
);

spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "pipe" });
run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath]);

if (pairOnly || !existsSync(join(home, ".openmausbot-bridge", "credentials.json"))) {
  console.log(`Pair this bridge:
  1. On the cloud harness host: curl -X POST http://127.0.0.1:8799/api/bridge/pairing
  2. node ${runtimeRoot}/bridge/index.js connect --url ${hostedUrl} --code <code> --name "${bridgeName}"
  3. launchctl kickstart -k gui/${process.getuid()}/com.posival.openmaus-bridge`);
} else {
  run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.posival.openmaus-bridge`]);
  console.log("bridge daemon restarted");
}
