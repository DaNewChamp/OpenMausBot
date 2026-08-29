#!/usr/bin/env node
// Validate hosted bots on a Linux VPS harness: config, workspaces, codex, roster.
// Run on the VPS: node scripts/audit-vps-bots.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.OMB_USER_DATA ?? "/var/lib/openmausbot";
const BOTS_PATH = join(DATA, "bots.json");
const WORKSPACES = join(DATA, "workspaces");

const sectionKey = (s) => (s ?? "").trim() || "General";
const bots = JSON.parse(readFileSync(BOTS_PATH, "utf8"));
const issues = [];
const ok = [];

function run(cmd, args, timeoutMs = 90_000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const codexBin = (() => {
  for (const c of ["codex", "/usr/bin/codex", "/usr/local/bin/codex"]) {
    if (c.includes("/") ? existsSync(c) : spawnSync("command", ["-v", c], { encoding: "utf8" }).status === 0) {
      return c.includes("/") ? c : "codex";
    }
  }
  return null;
})();

function codexPing(model) {
  const r = run(
    codexBin,
    ["exec", "--model", model, "--dangerously-bypass-approvals-and-sandbox", "Reply with exactly: ping"],
    120_000,
  );
  const ping = r.out.includes("\nping\n") || r.out.endsWith("ping");
  return { model, ping, detail: r.out.split("\n").slice(-4).join(" | ") };
}

for (const bot of bots) {
  const ws = join(WORKSPACES, bot.id);
  if (!existsSync(ws)) issues.push(`${bot.name}: missing workspace ${ws}`);
  for (const task of bot.tasks ?? []) {
    const cwd = task.cwd;
    if (cwd?.startsWith("/Users/")) issues.push(`${bot.name}: Mac task cwd ${cwd}`);
  }
  if (!bot.modelSelection?.instanceId) issues.push(`${bot.name}: no engine`);
  if (bot.hidden) ok.push(`${bot.name}: hidden (skipped from roster)`);
}

const chief = bots.find((b) => b.chiefOfStaff);
if (chief) {
  const sec = sectionKey(chief.section);
  const peers = bots.filter((b) => b.id !== chief.id && !b.hidden && sectionKey(b.section) === sec);
  ok.push(`Chief ${chief.name} (${sec}): ${peers.map((p) => p.name).join(", ") || "no peers"}`);
  if (sec === "General" && peers.length <= 1) {
    issues.push(`${chief.name} is in General — other desks won't appear in list_bots`);
  }
}

if (!codexBin) issues.push("codex CLI not found");
else {
  const login = run(codexBin, ["login", "status"], 15_000);
  if (!login.out.includes("Logged in")) issues.push(`codex not logged in: ${login.out.slice(0, 80)}`);
  for (const model of [...new Set(bots.map((b) => b.modelSelection?.model).filter(Boolean))]) {
    const r = codexPing(model);
    if (!r.ping) issues.push(`codex model ${model} failed smoke ping: ${r.detail}`);
    else ok.push(`codex ${model}: ping ok`);
  }
}

console.log("=== OpenMausBot VPS bot audit ===");
console.log(`data: ${DATA}`);
console.log(`bots: ${bots.length}`);
console.log("\n-- ok --");
for (const line of ok) console.log("  ", line);
if (issues.length) {
  console.log("\n-- issues --");
  for (const line of issues) console.log("  !!", line);
  process.exit(1);
}
console.log("\nAll checks passed.");
