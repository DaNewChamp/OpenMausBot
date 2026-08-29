export interface BridgeCredentials {
  url: string;
  bridgeId: string;
  bridgeToken: string;
  name: string;
  workerId?: string;
}

export interface BridgeJobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface LocalVmJobPayload {
  botId: string;
  action?: "run" | "stop" | "remove" | "recreate";
}

export interface PeekabooJobPayload {
  mode: "screenshot" | "see";
  question?: string;
}

interface BridgeJobBase {
  id: string;
  bridgeId: string;
  timeoutMs: number;
  createdAt: number;
  generation?: number;
}

export type BridgeJob =
  | (BridgeJobBase & {
      kind: "shell";
      command: string;
      cwd?: string;
    })
  | (BridgeJobBase & {
      kind: "local-vm-status" | "local-vm-action" | "local-vm-screenshot";
      payload: LocalVmJobPayload;
    })
  | (BridgeJobBase & {
      kind: "ssh-exec";
      alias: string;
      command: string;
      cwd?: string;
    })
  | (BridgeJobBase & {
      kind: "peekaboo-observe";
      payload: PeekabooJobPayload;
    });

export type LocalVmBridgeJob = Extract<
  BridgeJob,
  { kind: "local-vm-status" | "local-vm-action" | "local-vm-screenshot" }
>;

export type PeekabooBridgeJob = Extract<BridgeJob, { kind: "peekaboo-observe" }>;
