export interface BridgeCredentials {
  url: string;
  bridgeId: string;
  bridgeToken: string;
  name: string;
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
      kind: "hermes-discover";
      payload: Record<string, never>;
    })
  | (BridgeJobBase & {
      kind: "hermes-ensure-canonical";
      payload: { profile: string };
    })
  | (BridgeJobBase & {
      kind: "hermes-send";
      payload: {
        profile: string;
        text: string;
        threadId: string;
        turnId: string;
        model?: string;
      };
    })
  | (BridgeJobBase & {
      kind: "hermes-interrupt";
      payload: { profile: string; turnId?: string };
    });

export type LocalVmBridgeJob = Extract<
  BridgeJob,
  { kind: "local-vm-status" | "local-vm-action" | "local-vm-screenshot" }
>;
