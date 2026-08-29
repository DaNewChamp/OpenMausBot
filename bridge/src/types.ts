export interface BridgeCredentials {
  url: string;
  bridgeId: string;
  bridgeToken: string;
  name: string;
}

export interface LocalVmJobPayload {
  botId: string;
  action?: "run" | "stop" | "remove" | "recreate";
}

export type BridgeJob =
  | {
      id: string;
      bridgeId: string;
      kind: "shell";
      command: string;
      cwd?: string;
      timeoutMs: number;
      createdAt: number;
    }
  | {
      id: string;
      bridgeId: string;
      kind: "local-vm-status" | "local-vm-action" | "local-vm-screenshot";
      payload: LocalVmJobPayload;
      timeoutMs: number;
      createdAt: number;
    }
  | {
      id: string;
      bridgeId: string;
      kind: "ssh-exec";
      alias: string;
      command: string;
      cwd?: string;
      timeoutMs: number;
      createdAt: number;
    };

export type LocalVmBridgeJob = Extract<
  BridgeJob,
  { kind: "local-vm-status" | "local-vm-action" | "local-vm-screenshot" }
>;
