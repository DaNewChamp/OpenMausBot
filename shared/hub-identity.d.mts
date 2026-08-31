export interface HubIdentity {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: number;
}

export type PrivateDataDirStatus = "missing" | "ok" | "needs-repair" | "unavailable";

export interface HubIdentityReadOptions {
  dataDir: string;
  platform?: string;
}

export interface HubIdentityCreateOptions extends HubIdentityReadOptions {
  preferredId?: string;
  allowCreate?: boolean;
  now?: () => number;
  randomId?: () => string;
  randomUUID?: () => string;
  tempPathFactory?: (dataDir: string) => string;
  beforePublish?: () => void;
}

export class HubIdentityUnavailableError extends Error {
  constructor(message?: string);
}

export function inspectPrivateDataDir(dataDir: string, options?: { platform?: string }): PrivateDataDirStatus;
export function ensurePrivateDataDir(dataDir: string, options?: { platform?: string }): void;

export type HubIdentityReadResult =
  | { status: "missing" }
  | { status: "ok"; identity: HubIdentity }
  | { status: "unavailable"; error: string };

export function readHubIdentity(options: HubIdentityReadOptions): HubIdentityReadResult;
export function loadOrCreateHubIdentity(options: HubIdentityCreateOptions): HubIdentity;
