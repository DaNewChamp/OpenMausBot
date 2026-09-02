#!/usr/bin/env node
import { hostname } from "node:os";

import { heartbeat, registerBridge, submitResult } from "./client.ts";
import { credentialsPath, loadCredentials, saveCredentials } from "./config.ts";
import { runShellJob, runSshJob } from "./exec.ts";
import { runLocalVmJob } from "./local-vm.ts";
import { runHermesBridgeJob, type HermesBridgeJob } from "./hermes.ts";
import { defaultHermesBridgeRuntimeFactory } from "./hermes-runtime.ts";
import { runHermesJobSerialized } from "./hermes-queue.ts";
import {
  discoverLocalHermesEndpoints,
  type HermesEndpointDescriptor,
} from "./hermes-endpoints.ts";
import {
  bridgeHeartbeatIntervalMs,
  bridgeHermesExecutionEnabled,
} from "./daemon-timing.ts";
import type { BridgeJob, BridgeJobResult, BridgeCredentials } from "./types.ts";
import { parseHermesBridgeResult } from "../../shared/bridge-hermes-contract.ts";

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
let publishedHermesEndpoints: HermesEndpointDescriptor[] = [];

function cacheHermesEndpointsFromDiscover(result: BridgeJobResult, credentials: BridgeCredentials) {
  const identity = {
    bridgeId: credentials.bridgeId,
    computerName: credentials.name,
    hostInfo: hostname(),
  };
  if (result.exitCode !== 0) {
    publishedHermesEndpoints = discoverLocalHermesEndpoints({ ...identity, profileStore: "unavailable" });
    return;
  }
  try {
    const wire = parseHermesBridgeResult(result.stdout);
    if (wire.kind !== "hermes-discover") return;
    publishedHermesEndpoints = discoverLocalHermesEndpoints({
      ...identity,
      capabilities: { ...wire.body.capabilities },
      profiles: wire.body.profiles.map((row) => ({ name: row.profile })),
      profileStore: wire.body.state === "unavailable" ? "unavailable" : "readable",
    });
  } catch {
    publishedHermesEndpoints = discoverLocalHermesEndpoints({ ...identity, profileStore: "unreadable" });
  }
}

function isHermesJob(job: BridgeJob): job is BridgeJob & HermesBridgeJob {
  return job.kind === "hermes-discover"
    || job.kind === "hermes-ensure-canonical"
    || job.kind === "hermes-send"
    || job.kind === "hermes-interrupt";
}

async function handleJob(job: BridgeJob, signal?: AbortSignal) {
  if (job.kind === "shell") return runShellJob(job, signal);
  if (job.kind === "ssh-exec") return runSshJob(job, signal);
  if (job.kind === "local-vm-status" || job.kind === "local-vm-action" || job.kind === "local-vm-screenshot") {
    return runLocalVmJob(job);
  }
  if (isHermesJob(job)) {
    if (!bridgeHermesExecutionEnabled()) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "hermes capability disabled locally",
        truncated: false,
      };
    }
    return runHermesBridgeJob(job, hermesRuntimeFactory, signal);
  }
  return { exitCode: 1, stdout: "", stderr: `unsupported job kind: ${(job as BridgeJob).kind}`, truncated: false };
}

interface InFlightJob {
  generation: number;
  abort: AbortController;
  hermes: boolean;
}

async function runDaemon(credentials = loadCredentials()) {
  if (!credentials) throw new Error(`no saved credentials at ${credentialsPath()} — run: connect --url … --code …`);
  console.log(`bridge: ${credentials.name} → ${credentials.url}`);
  const inFlight = new Map<string, InFlightJob>();
  for (;;) {
    try {
      const { jobs, cancelJobIds } = await heartbeat(
        credentials,
        hostname(),
        bridgeCapabilities(),
        { hermesEndpoints: publishedHermesEndpoints },
      );
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
        const hermes = isHermesJob(job);
        inFlight.set(job.id, { generation: job.generation ?? 0, abort, hermes });
        const label =
          job.kind === "shell"
            ? job.command
            : job.kind === "ssh-exec"
              ? `ssh ${job.alias} ${job.command}`
              : job.kind.startsWith("hermes-")
                ? `${job.kind}${"profile" in job.payload ? ` ${job.payload.profile}` : ""}`
                : `${job.kind} ${"botId" in job.payload ? job.payload.botId : ""}`;
        console.log(`job ${job.id}: ${label}`);
        const run = () => handleJob(job, abort.signal)
          .then((result) => {
            if (job.kind === "hermes-discover") cacheHermesEndpointsFromDiscover(result, credentials);
            return submitResult(credentials, job.id, result, job.generation);
          })
          .catch((error) => {
            console.warn(`job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            const current = inFlight.get(job.id);
            if (current?.abort === abort) inFlight.delete(job.id);
          });
        if (hermes) {
          void runHermesJobSerialized(run);
        } else {
          void run();
        }
      }
    } catch (error) {
      console.warn(`bridge heartbeat: ${error instanceof Error ? error.message : String(error)}`);
    }
    const hermesActive = [...inFlight.values()].some((entry) => entry.hermes);
    await new Promise((resolve) => setTimeout(resolve, bridgeHeartbeatIntervalMs(hermesActive)));
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
