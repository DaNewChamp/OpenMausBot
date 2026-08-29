#!/usr/bin/env node
// Deploy OpenMausBot harness + companion on a Linux VPS (Servarica-style).
// Installs subscription engine CLIs (Codex, Cursor, Claude) and systemd units
// with PATH that includes ~/.local/bin — required for cursor-agent spawns.
import { execFileSync, spawnSync } from "node:child_process";
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vpsScripts = join(root, "scripts", "vps-runtime");
const runtimeRoot = process.env.OMB_RUNTIME_ROOT ?? "/opt/openmausbot/runtime";
const userData = process.env.OMB_USER_DATA ?? "/var/lib/openmausbot";
const harnessPort = Number(process.env.OMB_PORT ?? 8799);
const home = homedir();
const localBin = join(home, ".local", "bin");

const flags = new Set(process.argv.slice(2));
const skipBuild = flags.has("--skip-build");
const skipEngines = flags.has("--skip-engines");
const skipRestart = flags.has("--skip-restart");
const enginesArg = process.argv.find((a) => a.startsWith("--engines="));
const engines = new Set(
  (enginesArg?.slice("--engines=".length) ?? "codex,cursor,claude")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

if (process.platform !== "linux") {
  console.error("deploy-vps-harness is for Linux VPS hosts only (run over ssh servarica).");
  process.exit(1);
}

const packageManager =
  process.env.OMB_PACKAGE_MANAGER ??
  (spawnSync("command", ["-v", "pnpm"], { encoding: "utf8" }).status === 0
    ? "pnpm"
    : spawnSync("command", ["-v", "bun"], { encoding: "utf8" }).status === 0
      ? "bun"
      : "npm");

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPackageScript(script) {
  if (packageManager === "pnpm") run("pnpm", [script], { cwd: root });
  else if (packageManager === "bun") run("bun", ["run", script], { cwd: root });
  else run("npm", ["run", script], { cwd: root });
}

function commandExists(name) {
  return spawnSync("command", ["-v", name], { encoding: "utf8" }).status === 0;
}

function syncTree(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function installSystemd(unitName) {
  const src = join(vpsScripts, unitName);
  const dest = join("/etc/systemd/system", unitName);
  copyFileSync(src, dest);
  console.log(`systemd: installed ${dest}`);
}

async function waitHarnessReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${harnessPort}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`harness did not answer on :${harnessPort} within ${timeoutMs}ms`);
}

function engineAuthSummary(instances) {
  const want = ["codex", "cursor", "claude"];
  for (const id of want) {
    if (!engines.has(id)) continue;
    const inst = instances.find((i) => i.instanceId === id);
    if (!inst) {
      console.log(`  ${id}: not in fleet`);
      continue;
    }
    const s = inst.snapshot ?? {};
    const auth = s.authenticated === true ? "authenticated" : s.authenticated === false ? "needs login" : "n/a";
    console.log(`  ${id}: ${s.state ?? "?"} (${auth})${s.reason ? ` — ${s.reason}` : ""}`);
  }
}

function installEngines() {
  mkdirSync(localBin, { recursive: true });
  const pathEnv = `${localBin}:/usr/local/bin:/usr/bin:/bin`;
  const env = { ...process.env, PATH: pathEnv, NPM_CONFIG_LOGLEVEL: "error" };

  if (engines.has("codex") && !commandExists("codex")) {
    console.log("installing codex (@openai/codex)…");
    run("npm", ["install", "-g", "@openai/codex"], { env });
  }
  if (engines.has("claude") && !commandExists("claude")) {
    console.log("installing claude (claude-code)…");
    run("npm", ["install", "-g", "@anthropic-ai/claude-code"], { env });
  }
  if (engines.has("cursor") && !commandExists("cursor-agent")) {
    console.log("installing cursor-agent…");
    run("bash", ["-c", "curl https://cursor.com/install -fsS | bash"], { env });
  }
}

function printAuthRunbook() {
  console.log("\n=== Engine auth (run on this VPS as the harness user) ===");
  if (engines.has("codex")) {
    console.log("  Codex:    codex login          # ChatGPT OAuth in browser");
    console.log("            # or copy ~/.codex/auth.json from a logged-in Mac");
  }
  if (engines.has("cursor")) {
    console.log("  Cursor:   cursor-agent login   # opens browser URL");
    console.log("            # or set CURSOR_API_KEY in /etc/systemd/system/openmausbot-harness.service.d/cursor.conf");
  }
  if (engines.has("claude")) {
    console.log("  Claude:   claude login         # Anthropic OAuth");
  }
  console.log("  After auth: systemctl restart openmausbot-harness.service");
  console.log("  Verify:     curl -s http://127.0.0.1:8799/api/instances | jq '.instances[] | {id:.instanceId, state:.snapshot.state, auth:.snapshot.authenticated}'");
}

function fixMacWorkspaceCwds() {
  const botsPath = join(userData, "bots.json");
  if (!existsSync(botsPath)) return;
  const bots = JSON.parse(readFileSync(botsPath, "utf8"));
  let fixed = 0;
  for (const bot of bots) {
    for (const task of bot.tasks ?? []) {
      const cwd = task.cwd;
      if (typeof cwd !== "string" || !cwd.startsWith("/Users/")) continue;
      const local = join(userData, "workspaces", bot.id);
      console.log(`migrate cwd: ${bot.name ?? bot.id} → ${local}`);
      task.cwd = local;
      fixed++;
    }
  }
  if (fixed) writeFileSync(botsPath, `${JSON.stringify(bots, null, 2)}\n`);
}

function ensureHarnessDataDir() {
  const rootData = join(home, ".openmausbot");
  if (rootData === userData) return;
  try {
    rmSync(rootData, { recursive: true, force: true });
  } catch {
    /* busy mount or foreign tree */
  }
  mkdirSync(dirname(rootData), { recursive: true });
  execFileSync("ln", ["-sfn", userData, rootData]);
  console.log(`data dir: ${rootData} → ${userData}`);
}

mkdirSync("/var/log/openmausbot", { recursive: true });
mkdirSync(userData, { recursive: true });
mkdirSync(runtimeRoot, { recursive: true });
ensureHarnessDataDir();
fixMacWorkspaceCwds();

if (!skipBuild) {
  runPackageScript("build:server");
  runPackageScript("build:companion");
}

syncTree(join(root, "dist-server"), join(runtimeRoot, "server"));
syncTree(join(root, "dist-companion"), join(runtimeRoot, "companion"));
if (existsSync(join(root, "skills"))) {
  syncTree(join(root, "skills"), join(runtimeRoot, "resources", "skills"));
}

for (const script of ["start-harness.sh", "start-sidecar.sh"]) {
  const dest = join(runtimeRoot, script);
  copyFileSync(join(vpsScripts, script), dest);
  chmodSync(dest, 0o755);
}

if (!skipEngines) installEngines();

installSystemd("openmausbot-harness.service");
installSystemd("openmausbot-sidecar.service");
run("systemctl", ["daemon-reload"]);
run("systemctl", ["enable", "openmausbot-harness.service", "openmausbot-sidecar.service"]);

if (!skipRestart) {
  run("systemctl", ["restart", "openmausbot-harness.service"]);
  run("systemctl", ["restart", "openmausbot-sidecar.service"]);
  await waitHarnessReady();
}

try {
  const res = await fetch(`http://127.0.0.1:${harnessPort}/api/instances`);
  const body = await res.json();
  console.log("\n=== Engine status ===");
  engineAuthSummary(body.instances ?? []);
} catch (e) {
  console.warn("could not fetch /api/instances:", e instanceof Error ? e.message : e);
}

printAuthRunbook();
console.log(`\ndone — harness ${runtimeRoot} user-data ${userData}`);
