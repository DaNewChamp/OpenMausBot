#!/usr/bin/env node
import { hostname } from "node:os";

import { heartbeat, registerBridge, submitResult } from "./client.ts";
import { credentialsPath, loadCredentials, saveCredentials } from "./config.ts";
import { runShellJob } from "./exec.ts";

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function runDaemon(credentials = loadCredentials()) {
  if (!credentials) throw new Error(`no saved credentials at ${credentialsPath()} — run: connect --url … --code …`);
  console.log(`bridge: ${credentials.name} → ${credentials.url}`);
  for (;;) {
    try {
      const jobs = await heartbeat(credentials, hostname());
      for (const job of jobs) {
        if (job.kind !== "shell") continue;
        console.log(`job ${job.id}: ${job.command}`);
        const result = await runShellJob(job);
        await submitResult(credentials, job.id, result);
      }
    } catch (error) {
      console.warn(`bridge heartbeat: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function main() {
  if (command === "connect") {
    const url = flag("--url");
    const code = flag("--code");
    const name = flag("--name") ?? hostname();
    if (!url || !code) throw new Error("usage: connect --url https://openmaus.posival.com --code 123456 [--name mini]");
    const credentials = await registerBridge({ url, name, code, hostInfo: hostname() });
    saveCredentials(credentials);
    console.log(`paired ${credentials.name} (${credentials.bridgeId}) → ${credentials.url}`);
    return;
  }

  if (command === "run") {
    await runDaemon();
    return;
  }

  if (command === "status") {
    const credentials = loadCredentials();
    if (!credentials) {
      console.log("not paired");
      return;
    }
    console.log(JSON.stringify(credentials, null, 2));
    return;
  }

  console.log(`openmausbot-bridge

  connect --url <harness-url> --code <6-digit> [--name host]
  run
  status
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
