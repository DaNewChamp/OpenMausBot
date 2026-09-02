#!/usr/bin/env node
import { hostname } from "node:os";

import { heartbeat, registerBridge, submitResult } from "./client.ts";
import { credentialsPath, loadCredentials, saveCredentials } from "./config.ts";
import { runShellJob, runSshJob } from "./exec.ts";
import { runLocalVmJob } from "./local-vm.ts";
import { runHermesBridgeJob } from "./hermes.ts";
import { defaultHermesBridgeRuntimeFactory } from "./hermes-runtime.ts";
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
  if (process.env.OMB_BRIDGE_HERMES === "1") capabilities.push("hermes");
  return capabilities;
}

const hermesRuntimeFactory = defaultHermesBridgeRuntimeFactory();

async function handleJob(job: BridgeJob, signal?: AbortSignal) {
  if (job.kind === "shell") return runShellJob(job, signal);
  if (job.kind === "ssh-exec") return runSshJob(job, signal);
  if (job.kind === "local-vm-status" || job.kind === "local-vm-action" || job.kind === "local-vm-screenshot") {
    return runLocalVmJob(job);
  }
  if (
    job.kind === "hermes-discover"
    || job.kind === "hermes-ensure-canonical"
    || job.kind === "hermes-send"
    || job.kind === "hermes-interrupt"
  ) {
    return runHermesBridgeJob(job, hermesRuntimeFactory, signal);
  }
  return { exitCode: 1, stdout: "", stderr: `unsupported job kind: ${(job as BridgeJob).kind}`, truncated: false };
}

interface InFlightJob {
  generation: number;
  abort: AbortController;
}

async function runDaemon(credentials = loadCredentials()) {
  if (!credentials) throw new Error(`no saved credentials at ${credentialsPath()} — run: connect --url … --code …`);
  console.log(`bridge: ${credentials.name} → ${credentials.url}`);
  const inFlight = new Map<string, InFlightJob>();
  for (;;) {
    try {
      const { jobs, cancelJobIds } = await heartbeat(credentials, hostname(), bridgeCapabilities());
      for (const jobId of cancelJobIds) {
        inFlight.get(jobId)?.abort.abort();
      }
      for (const job of jobs) {
        const existing = inFlight.get(job.id);
        if (existing) {
          if (existing.generation === (job.generation ?? existing.generation)) {
            console.log(`job ${job.id}: already in flight, skipping duplicate delivery`);
            continue;
          }
          existing.abort.abort();
          inFlight.delete(job.id);
        }
        const abort = new AbortController();
        inFlight.set(job.id, { generation: job.generation ?? 0, abort });
        const label =
          job.kind === "shell"
            ? job.command
            : job.kind === "ssh-exec"
              ? `ssh ${job.alias} ${job.command}`
              : job.kind.startsWith("hermes-")
                ? `${job.kind}${"profile" in job.payload ? ` ${job.payload.profile}` : ""}`
                : `${job.kind} ${"botId" in job.payload ? job.payload.botId : ""}`;
        console.log(`job ${job.id}: ${label}`);
        void handleJob(job, abort.signal)
          .then((result) => submitResult(credentials, job.id, result, job.generation))
          .catch((error) => {
            console.warn(`job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            const current = inFlight.get(job.id);
            if (current?.abort === abort) inFlight.delete(job.id);
          });
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

  OMB_BRIDGE_SHELL=1        advertise shell execution capability
  OMB_BRIDGE_LOCAL_VM=1     advertise local-vm relay capability
  OMB_BRIDGE_SSH_FORWARD=1  advertise ssh-forward capability
  OMB_BRIDGE_HERMES=1       advertise typed Hermes bridge capability
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
