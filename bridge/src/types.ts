export interface BridgeCredentials {
  url: string;
  bridgeId: string;
  bridgeToken: string;
  name: string;
}

export interface BridgeJob {
  id: string;
  bridgeId: string;
  kind: "shell";
  command: string;
  cwd?: string;
  timeoutMs: number;
  createdAt: number;
}
