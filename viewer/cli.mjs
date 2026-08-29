#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudFetch, credentialsPath, hasCredentials, loadCredentials, pairViewer } from "./lib/client.mjs";

const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  if (command === "pair") {
    const url = flag("--url") ?? "https://openmaus.posival.com";
    const code = flag("--code");
    const deviceName = flag("--name") ?? "V Bot Viewer";
    if (!code) throw new Error("usage: pair --code 123456 [--url https://openmaus.posival.com] [--name label]");
    const credentials = await pairViewer({ url, code, deviceName });
    console.log(`paired ${credentials.deviceName} → ${credentials.url}`);
    console.log(`saved ${credentialsPath()}`);
    return;
  }

  if (command === "bots") {
    const body = await cloudFetch("/api/bots?messages=0");
    for (const bot of body.bots ?? []) {
      console.log(`${bot.busy ? "●" : "○"} ${bot.name}${bot.title ? ` — ${bot.title}` : ""} [${bot.id}]`);
    }
    return;
  }

  if (command === "open") {
    if (!hasCredentials()) throw new Error("pair first: node viewer/cli.mjs pair --code …");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const electron = spawnSync("pnpm", ["exec", "electron", "viewer/electron/main.mjs"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    process.exit(electron.status ?? 1);
    return;
  }

  if (command === "status") {
    console.log(loadCredentials() ? JSON.stringify(loadCredentials(), null, 2) : "not paired");
    return;
  }

  console.log(`v-bot cloud viewer

  pair --code <6-digit> [--url https://openmaus.posival.com] [--name label]
  bots
  open
  status

Start pairing on the cloud harness:
  ssh servarica 'curl -s -X POST http://127.0.0.1:28811/pairing'
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
