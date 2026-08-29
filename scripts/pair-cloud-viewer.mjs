#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2] ?? "V Bot Viewer";
const url = process.env.OMB_VIEWER_URL ?? "https://openmaus.posival.com";
const host = process.env.OMB_VPS_HOST ?? "servarica";

const pairing = spawnSync("ssh", [host, "curl -s -X POST http://127.0.0.1:28811/pairing"], { encoding: "utf8" });
if (pairing.status !== 0) {
  console.error(pairing.stderr || pairing.stdout);
  process.exit(pairing.status ?? 1);
}
const { code } = JSON.parse(pairing.stdout);
console.log(`pairing code: ${code} (120s)`);
const paired = spawnSync("node", ["viewer/cli.mjs", "pair", "--url", url, "--code", code, "--name", name], {
  cwd: root,
  stdio: "inherit",
});
process.exit(paired.status ?? 1);
