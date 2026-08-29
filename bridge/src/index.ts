#!/usr/bin/env node
import { hostname } from "node:os";

import { heartbeat, registerBridge, submitResult } from "./client.ts";
import { credentialsPath, loadCredentials, saveCredentials } from "./config.ts";
import { runShellJob, runSshJob } from "./exec.ts";
import { runLocalVmJob } from "./local-vm.ts";
import type { BridgeJob } from "./types.ts";

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function bridgeCapabilities(): string[] {
  const capabilities: string[] = [];
  if (process.env.OMB_BRIDGE_SHELL === "1") capabilities.push("shell");
  if (process.env.OMB_BRIDGE_LOCAL_VM === "1") capabilities.push("local-vm");
  if (process.env.OMB_BRIDGE_SSH_FORWARD === "1") capabilities.push("ssh-forward");
  return capabilities;
}

async function handleJob(job: BridgeJob) {
  if (job.kind === "shell") return runShellJob(job);
  if (job.kind === "ssh-exec") return runSshJob(job);
  if (job.kind === "local-vm-status" || job.kind === "local-vm-action" || job.kind === "local-vm-screenshot") {
    return runLocalVmJob(job);
  }
  return { exitCode: 1, stdout: "", stderr: `unsupported job kind: ${(job as BridgeJob).kind}`, truncated: false };
}

async function runDaemon(credentials = loadCredentials()) {
  if (!credentials) throw new Error(`no saved credentials at ${credentialsPath()} — run: connect --url … --code …`);
  console.log(`bridge: ${credentials.name} → ${credentials.url}`);
  for (;;) {
    try {
      const jobs = await heartbeat(credentials, hostname(), bridgeCapabilities());
      for (const job of jobs) {
        const label =
          job.kind === "shell"
            ? job.command
            : job.kind === "ssh-exec"
              ? `ssh ${job.alias} ${job.command}`
              : `${job.kind} ${job.payload.botId}`;
        console.log(`job ${job.id}: ${label}`);
        const result = await handleJob(job);
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
    const credentials = await registerBridge({
      url,
      name,
      code,
      capabilities: bridgeCapabilities(),
      hostInfo: hostname(),
    });
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

  OMB_BRIDGE_LOCAL_VM=1     advertise local-vm relay capability
  OMB_BRIDGE_SSH_FORWARD=1  advertise ssh-forward capability
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
