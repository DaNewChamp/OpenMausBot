import {
  encodeHermesBridgeResult,
  scrubRuntimeEvents,
  type HermesBridgeDiscoveryWire,
  type HermesBridgeEnsureCanonicalWire,
  type HermesBridgeInterruptWire,
  type HermesBridgeResultWire,
  type HermesBridgeSendWire,
  type ScrubbedRuntimeEvent,
} from "../../shared/bridge-hermes-contract.ts";
import {
  defaultHermesSignInLaunch,
  hermesSignInArgvIsSetup,
  HERMES_SIGNIN_ARGV,
  type HermesSignInLaunch,
  type HermesSignInLaunchResult,
} from "../../shared/hermes-signin-launch.ts";
import type { BridgeJobResult } from "./types.ts";
import { discoverLocalHermesEndpoints, type HermesEndpointDescriptor } from "./hermes-endpoints.ts";

export function hermesEndpointsFromDiscovery(
  discovery: HermesBridgeDiscoveryWire,
  identity: { bridgeId: string; computerName: string; hostInfo?: string },
): HermesEndpointDescriptor[] {
  return discoverLocalHermesEndpoints({
    bridgeId: identity.bridgeId,
    computerName: identity.computerName,
    hostInfo: identity.hostInfo,
    capabilities: { ...discovery.capabilities },
    profiles: discovery.profiles.map((row) => ({ name: row.profile })),
    profileStore: discovery.state === "unavailable" ? "unavailable" : "readable",
  });
}

export type HermesBridgeJob =
  | {
      kind: "hermes-discover";
      payload: Record<string, never>;
    }
  | {
      kind: "hermes-ensure-canonical";
      payload: { profile: string };
    }
  | {
      kind: "hermes-send";
      payload: {
        profile: string;
        text: string;
        threadId: string;
        turnId: string;
        model?: string;
      };
    }
  | {
      kind: "hermes-interrupt";
      payload: { profile: string; turnId?: string };
    }
  | {
      kind: "hermes-signin";
      payload: { argv: ["setup"] };
    };

export interface HermesBridgeRuntime {
  discover(): Promise<HermesBridgeDiscoveryWire>;
  ensureCanonical(profile: string): Promise<HermesBridgeEnsureCanonicalWire>;
  send(
    payload: Extract<HermesBridgeJob, { kind: "hermes-send" }>["payload"],
    signal?: AbortSignal,
  ): Promise<HermesBridgeSendWire>;
  interrupt(payload: Extract<HermesBridgeJob, { kind: "hermes-interrupt" }>["payload"]): Promise<HermesBridgeInterruptWire>;
  close(): Promise<void>;
}

export interface HermesBridgeRuntimeFactory {
  create(): Promise<HermesBridgeRuntime>;
}

export async function runHermesBridgeJob(
  job: HermesBridgeJob,
  factory: HermesBridgeRuntimeFactory,
  signal?: AbortSignal,
): Promise<BridgeJobResult> {
  if (signal?.aborted) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "cancelled",
      truncated: false,
    };
  }

  const runtime = await factory.create();
  try {
    let wire: HermesBridgeResultWire;
    if (job.kind === "hermes-discover") {
      wire = { kind: "hermes-discover", body: await runtime.discover() };
    } else if (job.kind === "hermes-ensure-canonical") {
      wire = { kind: "hermes-ensure-canonical", body: await runtime.ensureCanonical(job.payload.profile) };
    } else if (job.kind === "hermes-send") {
      if (signal?.aborted) {
        await runtime.interrupt({ profile: job.payload.profile, turnId: job.payload.turnId });
        return { exitCode: 1, stdout: "", stderr: "cancelled", truncated: false };
      }
      const body = await runtime.send(job.payload, signal);
      if (signal?.aborted) {
        await runtime.interrupt({ profile: job.payload.profile, turnId: job.payload.turnId });
        return { exitCode: 1, stdout: "", stderr: "cancelled", truncated: false };
      }
      wire = { kind: "hermes-send", body };
    } else if (job.kind === "hermes-interrupt") {
      wire = { kind: "hermes-interrupt", body: await runtime.interrupt(job.payload) };
    } else {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "hermes bridge job failed",
        truncated: false,
      };
    }
    return {
      exitCode: 0,
      stdout: encodeHermesBridgeResult(wire),
      stderr: "",
      truncated: false,
    };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "hermes bridge job failed",
      truncated: false,
    };
  } finally {
    await runtime.close().catch(() => {});
  }
}

const SIGNIN_HANDOFF_FAILED = {
  exitCode: 1,
  stdout: "",
  stderr: "hermes setup handoff failed",
  truncated: false,
} as const;

export async function runHermesSignInJob(
  job: Extract<HermesBridgeJob, { kind: "hermes-signin" }>,
  launch: (command: HermesSignInLaunch) => Promise<HermesSignInLaunchResult> = defaultHermesSignInLaunch,
): Promise<BridgeJobResult> {
  if (!hermesSignInArgvIsSetup(job.payload.argv)) {
    return { ...SIGNIN_HANDOFF_FAILED };
  }
  const result = await launch({ kind: "terminal", argv: HERMES_SIGNIN_ARGV });
  if (!result.ok) return { ...SIGNIN_HANDOFF_FAILED };
  try {
    return {
      exitCode: 0,
      stdout: encodeHermesBridgeResult({
        kind: "hermes-signin",
        body: { kind: result.kind },
      }),
      stderr: "",
      truncated: false,
    };
  } catch {
    return { ...SIGNIN_HANDOFF_FAILED };
  }
}

export function createFakeHermesBridgeRuntime(state: {
  discover?: HermesBridgeDiscoveryWire;
  ensure?: HermesBridgeEnsureCanonicalWire;
  send?: HermesBridgeSendWire;
  interrupt?: HermesBridgeInterruptWire;
}): HermesBridgeRuntimeFactory {
  return {
    async create() {
      return {
        discover: async () => state.discover ?? {
          state: "available",
          capabilities: {
            roster: true,
            canonicalChat: true,
            send: true,
            finalResponse: true,
            events: true,
            stop: true,
            routinesRead: false,
            messageAgent: false,
            groups: false,
            crossMachine: false,
            queueing: false,
            steer: false,
            attachments: false,
            adoptMint: false,
            approvals: false,
            exclusiveSubmit: false,
          },
          profiles: [],
        },
        ensureCanonical: async () => state.ensure ?? { state: "present", adopted: true },
        send: async (payload, _signal) => state.send ?? {
          ok: true,
          turnId: payload.turnId,
          events: [{
            eventId: "evt-1",
            provider: "hermesBot",
            threadId: payload.threadId,
            turnId: payload.turnId,
            createdAt: "2026-09-01T00:00:00.000Z",
            type: "turn.completed",
            ok: true,
          } satisfies ScrubbedRuntimeEvent],
        },
        interrupt: async () => state.interrupt ?? { ok: true },
        close: async () => {},
      };
    },
  };
}

export { scrubRuntimeEvents };
