import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { validHermesBridgeProfile } from "../shared/bridge-hermes-contract.ts";
import {
  parseFleetChatJobPayload,
  type FleetChatJobPayload,
} from "../shared/bridge-fleet-contract.ts";

export type BridgeCapability = "shell" | "local-vm" | "ssh-forward" | "hermes";

export interface BridgeRecord {
  id: string;
  name: string;
  tokenHash: string;
  capabilities: BridgeCapability[];
  grantedCapabilities: BridgeCapability[];
  createdAt: number;
  lastSeenAt: number;
  hostInfo?: string;
}

export type BridgeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type LocalVmBridgeJobKind = "local-vm-status" | "local-vm-action" | "local-vm-screenshot" | "local-vm-input";

export type HermesBridgeJobKind =
  | "hermes-discover"
  | "hermes-ensure-canonical"
  | "hermes-send"
  | "hermes-interrupt"
  | "hermes-signin";

export interface HermesBridgeDiscoverPayload {}

export interface HermesBridgeEnsureCanonicalPayload {
  profile: string;
}

export interface HermesBridgeSendPayload {
  profile: string;
  text: string;
  threadId: string;
  turnId: string;
  model?: string;
}

export interface HermesBridgeInterruptPayload {
  profile: string;
  turnId?: string;
}

export interface HermesBridgeSignInPayload {
  argv: ["setup"];
}

export interface LocalVmJobPayload {
  botId: string;
  action?: "run" | "stop" | "remove" | "recreate";
  input?: {
    action: "click" | "scroll" | "type" | "key";
    x?: number;
    y?: number;
    button?: "left" | "right";
    double?: boolean;
    direction?: "up" | "down";
    clicks?: number;
    text?: string;
    keys?: string;
  };
}

interface BridgeJobBase {
  id: string;
  bridgeId: string;
  timeoutMs: number;
  createdAt: number;
  generation?: number;
}

export interface ShellBridgeJob extends BridgeJobBase {
  kind: "shell";
  command: string;
  cwd?: string;
}

export interface LocalVmBridgeJob extends BridgeJobBase {
  kind: LocalVmBridgeJobKind;
  payload: LocalVmJobPayload;
}

export interface SshBridgeJob extends BridgeJobBase {
  kind: "ssh-exec";
  alias: string;
  command: string;
  cwd?: string;
}

export interface HermesDiscoverBridgeJob extends BridgeJobBase {
  kind: "hermes-discover";
  payload: HermesBridgeDiscoverPayload;
}

export interface HermesEnsureCanonicalBridgeJob extends BridgeJobBase {
  kind: "hermes-ensure-canonical";
  payload: HermesBridgeEnsureCanonicalPayload;
}

export interface HermesSendBridgeJob extends BridgeJobBase {
  kind: "hermes-send";
  payload: HermesBridgeSendPayload;
}

export interface HermesInterruptBridgeJob extends BridgeJobBase {
  kind: "hermes-interrupt";
  payload: HermesBridgeInterruptPayload;
}

export interface HermesSignInBridgeJob extends BridgeJobBase {
  kind: "hermes-signin";
  payload: HermesBridgeSignInPayload;
}

export interface FleetChatBridgeJob extends BridgeJobBase {
  kind: "fleet-chat";
  payload: FleetChatJobPayload;
}

export type BridgeJob =
  | ShellBridgeJob
  | LocalVmBridgeJob
  | SshBridgeJob
  | HermesDiscoverBridgeJob
  | HermesEnsureCanonicalBridgeJob
  | HermesSendBridgeJob
  | HermesInterruptBridgeJob
  | HermesSignInBridgeJob
  | FleetChatBridgeJob;

export interface BridgeJobResult {
  jobId: string;
  bridgeId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  finishedAt: number;
  generation?: number;
}

export interface BridgeJobRecord {
  id: string;
  idempotencyKey?: string;
  bridgeId: string;
  status: BridgeJobStatus;
  job: BridgeJob;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempt: number;
  maxAttempts: number;
  deliveryCount: number;
  lastDeliveredAt?: number;
  generation: number;
  cancelRequestedAt?: number;
  result?: BridgeJobResult;
  error?: string;
}

interface PairingWindow {
  code: string;
  token: string;
  expiresAt: number;
  attemptsLeft: number;
}

interface BridgeStoreFile {
  bridges: BridgeRecord[];
}

interface BridgeJobsFile {
  jobs: BridgeJobRecord[];
}

export interface EnqueueBridgeJobOpts {
  idempotencyKey?: string;
  maxAttempts?: number;
}

const PAIRING_TTL_MS = 120_000;
const MAX_PAIRING_ATTEMPTS = 5;
const QUEUED_JOB_TTL_MS = 30 * 60_000;
const TERMINAL_JOB_RETENTION_MS = 24 * 60 * 60_000;
const STALE_RUNNING_MS = 30_000;
const JOB_STORE_MAX = 500;
const DEFAULT_MAX_ATTEMPTS = 3;
const IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

function bridgesPath(): string {
  return join(DATA_DIR, "bridges.json");
}

function bridgeJobsPath(): string {
  return join(DATA_DIR, "bridge-jobs.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function writeStore(store: BridgeStoreFile): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(bridgesPath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function readStore(): BridgeStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(bridgesPath(), "utf8")) as BridgeStoreFile;
    return { bridges: (parsed.bridges ?? []).map(normalizeBridge) };
  } catch {
    return { bridges: [] };
  }
}

function readJobsFile(): BridgeJobsFile {
  try {
    return JSON.parse(readFileSync(bridgeJobsPath(), "utf8")) as BridgeJobsFile;
  } catch {
    return { jobs: [] };
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bridgeRecord(bridgeId: string): BridgeRecord | null {
  return readStore().bridges.find((b) => b.id === bridgeId) ?? null;
}

function requireCapability(bridgeId: string, capability: BridgeCapability): BridgeRecord {
  const bridge = bridgeRecord(bridgeId);
  if (!bridge) throw new Error("unknown bridge");
  const normalized = normalizeBridge(bridge);
  if (!normalized.capabilities.includes(capability)) throw new Error(`bridge lacks ${capability} capability`);
  if (!normalized.grantedCapabilities.includes(capability)) {
    throw new Error(`bridge lacks granted ${capability} capability`);
  }
  return normalized;
}

function requireHermesProfile(profile: string): string {
  const normalized = validHermesBridgeProfile(profile);
  if (!normalized) throw new Error("invalid hermes profile");
  return normalized;
}

function isTerminal(status: BridgeJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export class IdempotencyConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("idempotency key conflict");
    this.name = "IdempotencyConflictError";
  }
}

export function jobFingerprint(job: BridgeJob): string {
  if (job.kind === "shell") return `shell\0${job.command}\0${job.cwd ?? ""}`;
  if (job.kind === "ssh-exec") return `ssh-exec\0${job.alias}\0${job.command}\0${job.cwd ?? ""}`;
  if (job.kind === "hermes-discover") return "hermes-discover";
  if (job.kind === "hermes-ensure-canonical") return `hermes-ensure-canonical\0${job.payload.profile}`;
  if (job.kind === "hermes-send") {
    return `hermes-send\0${job.payload.profile}\0${job.payload.threadId}\0${job.payload.turnId}\0${job.payload.text}\0${job.payload.model ?? ""}`;
  }
  if (job.kind === "hermes-interrupt") {
    return `hermes-interrupt\0${job.payload.profile}\0${job.payload.turnId ?? ""}`;
  }
  if (job.kind === "hermes-signin") return "hermes-signin";
  if (job.kind === "fleet-chat") {
    return `fleet-chat\0${job.payload.baseUrl}\0${job.payload.model}\0${job.payload.threadId}\0${job.payload.turnId}`;
  }
  return `${job.kind}\0${job.payload.botId}\0${job.payload.action ?? ""}`;
}

function normalizeBridge(bridge: BridgeRecord): BridgeRecord {
  return {
    ...bridge,
    grantedCapabilities: Array.isArray(bridge.grantedCapabilities)
      ? bridge.grantedCapabilities
      : [...(bridge.capabilities ?? [])],
  };
}

export class BridgeRegistry {
  private pairing: PairingWindow | null = null;
  private jobs = new Map<string, BridgeJobRecord>();

  constructor() {
    for (const record of readJobsFile().jobs) {
      this.jobs.set(record.id, { ...record, generation: record.generation ?? record.deliveryCount ?? 0 });
    }
    this.pruneJobs(Date.now());
  }

  private persistJobs(): void {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(bridgeJobsPath(), `${JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private touchRecord(record: BridgeJobRecord, now = Date.now()): void {
    record.updatedAt = now;
    this.jobs.set(record.id, record);
    this.persistJobs();
  }

  private pruneJobs(now: number): void {
    let changed = false;
    for (const [id, record] of this.jobs) {
      if (isTerminal(record.status) && record.finishedAt && now - record.finishedAt > TERMINAL_JOB_RETENTION_MS) {
        this.jobs.delete(id);
        changed = true;
      }
    }
    if (this.jobs.size > JOB_STORE_MAX) {
      const terminal = [...this.jobs.entries()]
        .filter(([, record]) => isTerminal(record.status))
        .sort((a, b) => (a[1].finishedAt ?? 0) - (b[1].finishedAt ?? 0));
      for (const [id] of terminal.slice(0, this.jobs.size - JOB_STORE_MAX)) {
        this.jobs.delete(id);
        changed = true;
      }
    }
    if (changed) this.persistJobs();
  }

  private findByIdempotencyKey(bridgeId: string, idempotencyKey: string, now: number): BridgeJobRecord | null {
    for (const record of this.jobs.values()) {
      if (record.bridgeId !== bridgeId || record.idempotencyKey !== idempotencyKey) continue;
      if (isTerminal(record.status)) {
        if (record.finishedAt && now - record.finishedAt <= IDEMPOTENCY_WINDOW_MS) return record;
        continue;
      }
      return record;
    }
    return null;
  }

  reconcile(now = Date.now()): void {
    this.pruneJobs(now);
    let changed = false;
    for (const record of this.jobs.values()) {
      if (record.status === "cancelled" || record.status === "succeeded" || record.status === "failed") continue;

      if (record.cancelRequestedAt) {
        if (record.status === "queued") {
          record.status = "cancelled";
          record.finishedAt = now;
          record.error = "cancelled";
          changed = true;
          continue;
        }
        const bridge = bridgeRecord(record.bridgeId);
        const bridgeOffline = !bridge || now - bridge.lastSeenAt > STALE_RUNNING_MS;
        const started = record.startedAt ?? record.createdAt;
        const pastDeadline = now > started + record.job.timeoutMs + STALE_RUNNING_MS;
        if (bridgeOffline || pastDeadline) {
          record.status = "cancelled";
          record.finishedAt = now;
          record.error = "cancelled";
          changed = true;
        }
        continue;
      }

      if (record.status === "queued" && now - record.createdAt > QUEUED_JOB_TTL_MS) {
        record.status = "failed";
        record.finishedAt = now;
        record.error = "queued job expired";
        changed = true;
        continue;
      }

      if (record.status === "running") {
        const started = record.startedAt ?? record.createdAt;
        const deadline = started + record.job.timeoutMs + STALE_RUNNING_MS;
        if (now > deadline) {
          record.status = "failed";
          record.finishedAt = now;
          record.error = "job timed out";
          changed = true;
          continue;
        }

        const bridge = bridgeRecord(record.bridgeId);
        const bridgeOffline = !bridge || now - bridge.lastSeenAt > STALE_RUNNING_MS;
        const staleDelivery =
          record.lastDeliveredAt != null && now - record.lastDeliveredAt > STALE_RUNNING_MS;
        if (bridgeOffline && staleDelivery) {
          if (record.attempt >= record.maxAttempts) {
            record.status = "failed";
            record.finishedAt = now;
            record.error = "bridge offline; retry attempts exhausted";
          } else {
            record.status = "queued";
            record.startedAt = undefined;
            record.lastDeliveredAt = undefined;
          }
          changed = true;
        }
      }
    }
    if (changed) this.persistJobs();
  }

  list(): Array<Omit<BridgeRecord, "tokenHash"> & { online: boolean }> {
    const now = Date.now();
    return readStore().bridges.map(({ tokenHash: _tokenHash, ...rest }) => ({
      ...rest,
      online: now - rest.lastSeenAt <= 20_000,
    }));
  }

  startPairing(): { code: string; expiresIn: number } {
    this.pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      token: randomBytes(24).toString("hex"),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      attemptsLeft: MAX_PAIRING_ATTEMPTS,
    };
    return { code: this.pairing.code, expiresIn: PAIRING_TTL_MS / 1000 };
  }

  register(input: {
    name: string;
    code?: string;
    pairingToken?: string;
    capabilities?: BridgeCapability[];
    hostInfo?: string;
  }): { bridgeId: string; bridgeToken: string } {
    const window = this.pairing;
    if (!window || Date.now() > window.expiresAt) throw new Error("pairing window closed");
    const ok =
      (input.pairingToken && safeEqual(input.pairingToken, window.token)) ||
      (input.code && safeEqual(input.code, window.code));
    if (!ok) {
      window.attemptsLeft -= 1;
      if (window.attemptsLeft <= 0) this.pairing = null;
      throw new Error("invalid pairing credential");
    }
    this.pairing = null;

    const bridgeToken = randomBytes(24).toString("hex");
    const record: BridgeRecord = {
      id: randomUUID(),
      name: input.name.trim() || "bridge",
      tokenHash: hashToken(bridgeToken),
      capabilities: input.capabilities ?? [],
      grantedCapabilities: input.capabilities ?? [],
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      hostInfo: input.hostInfo,
    };
    const store = readStore();
    store.bridges.push(record);
    writeStore(store);
    return { bridgeId: record.id, bridgeToken };
  }

  authorize(header: string | string[] | undefined): BridgeRecord | null {
    const raw = Array.isArray(header) ? "" : (header ?? "");
    const match = /^Bearer ([0-9a-f]{48})$/i.exec(raw);
    if (!match) return null;
    const digest = hashToken(match[1]!);
    const store = readStore();
    return store.bridges.find((b) => safeEqual(b.tokenHash, digest)) ?? null;
  }

  touch(bridgeId: string, patch?: { hostInfo?: string; capabilities?: BridgeCapability[] }): BridgeRecord | null {
    const store = readStore();
    const bridge = store.bridges.find((b) => b.id === bridgeId);
    if (!bridge) return null;
    bridge.lastSeenAt = Date.now();
    if (patch?.hostInfo) bridge.hostInfo = patch.hostInfo;
    if (patch?.capabilities) {
      const granted = new Set(bridge.grantedCapabilities ?? bridge.capabilities);
      bridge.capabilities = patch.capabilities.filter((capability) => granted.has(capability));
    }
    writeStore(store);
    return bridge;
  }

  revoke(bridgeId: string): boolean {
    const store = readStore();
    const next = store.bridges.filter((b) => b.id !== bridgeId);
    if (next.length === store.bridges.length) return false;
    writeStore({ bridges: next });
    const now = Date.now();
    let changed = false;
    for (const record of this.jobs.values()) {
      if (record.bridgeId !== bridgeId || isTerminal(record.status)) continue;
      record.cancelRequestedAt = now;
      if (record.status === "queued") {
        record.status = "cancelled";
        record.finishedAt = now;
        record.error = "cancelled";
      }
      record.updatedAt = now;
      changed = true;
    }
    if (changed) this.persistJobs();
    return true;
  }

  getJob(jobId: string): BridgeJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(bridgeId?: string): BridgeJobRecord[] {
    const jobs = [...this.jobs.values()];
    return bridgeId ? jobs.filter((job) => job.bridgeId === bridgeId) : jobs;
  }

  private existingIdempotent(
    bridgeId: string,
    idempotencyKey: string,
    fingerprint: string,
    now: number,
  ): BridgeJobRecord | null {
    const existing = this.findByIdempotencyKey(bridgeId, idempotencyKey, now);
    if (!existing) return null;
    if (jobFingerprint(existing.job) !== fingerprint) throw new IdempotencyConflictError();
    return existing;
  }

  private enqueueRecord(
    bridgeId: string,
    job: BridgeJob,
    opts: EnqueueBridgeJobOpts = {},
  ): BridgeJobRecord {
    const now = Date.now();
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), now);
      if (existing) return existing;
    }
    const record: BridgeJobRecord = {
      id: job.id,
      idempotencyKey: opts.idempotencyKey,
      bridgeId,
      status: "queued",
      job,
      createdAt: now,
      updatedAt: now,
      attempt: 0,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      deliveryCount: 0,
      generation: 0,
    };
    this.jobs.set(record.id, record);
    this.persistJobs();
    return record;
  }

  enqueueShell(
    bridgeId: string,
    command: string,
    cwd?: string,
    timeoutMs = 60_000,
    opts: EnqueueBridgeJobOpts = {},
  ): ShellBridgeJob {
    requireCapability(bridgeId, "shell");
    const job: ShellBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "shell",
      command,
      cwd,
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as ShellBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueLocalVmJob(
    bridgeId: string,
    kind: LocalVmBridgeJobKind,
    payload: LocalVmJobPayload,
    timeoutMs = 120_000,
    opts: EnqueueBridgeJobOpts = {},
  ): LocalVmBridgeJob {
    requireCapability(bridgeId, "local-vm");
    const job: LocalVmBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind,
      payload,
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as LocalVmBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueSshExec(
    bridgeId: string,
    alias: string,
    command: string,
    cwd?: string,
    timeoutMs = 60_000,
    opts: EnqueueBridgeJobOpts = {},
  ): SshBridgeJob {
    requireCapability(bridgeId, "ssh-forward");
    const job: SshBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "ssh-exec",
      alias,
      command,
      cwd,
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as SshBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueHermesDiscover(
    bridgeId: string,
    timeoutMs = 45_000,
    opts: EnqueueBridgeJobOpts = {},
  ): HermesDiscoverBridgeJob {
    requireCapability(bridgeId, "hermes");
    const job: HermesDiscoverBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "hermes-discover",
      payload: {},
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as HermesDiscoverBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueHermesEnsureCanonical(
    bridgeId: string,
    profile: string,
    timeoutMs = 60_000,
    opts: EnqueueBridgeJobOpts = {},
  ): HermesEnsureCanonicalBridgeJob {
    requireCapability(bridgeId, "hermes");
    const normalizedProfile = requireHermesProfile(profile);
    const job: HermesEnsureCanonicalBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "hermes-ensure-canonical",
      payload: { profile: normalizedProfile },
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as HermesEnsureCanonicalBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueHermesSend(
    bridgeId: string,
    payload: HermesBridgeSendPayload,
    timeoutMs = 180_000,
    opts: EnqueueBridgeJobOpts = {},
  ): HermesSendBridgeJob {
    requireCapability(bridgeId, "hermes");
    const normalizedProfile = requireHermesProfile(payload.profile);
    const job: HermesSendBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "hermes-send",
      payload: { ...payload, profile: normalizedProfile },
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as HermesSendBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueHermesInterrupt(
    bridgeId: string,
    payload: HermesBridgeInterruptPayload,
    timeoutMs = 30_000,
    opts: EnqueueBridgeJobOpts = {},
  ): HermesInterruptBridgeJob {
    requireCapability(bridgeId, "hermes");
    const normalizedProfile = requireHermesProfile(payload.profile);
    const job: HermesInterruptBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "hermes-interrupt",
      payload: { ...payload, profile: normalizedProfile },
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as HermesInterruptBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueHermesSignIn(
    bridgeId: string,
    timeoutMs = 15_000,
    opts: EnqueueBridgeJobOpts = {},
  ): HermesSignInBridgeJob {
    requireCapability(bridgeId, "hermes");
    const job: HermesSignInBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "hermes-signin",
      payload: { argv: ["setup"] },
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as HermesSignInBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  enqueueFleetChat(
    bridgeId: string,
    payload: FleetChatJobPayload,
    timeoutMs = 180_000,
    opts: EnqueueBridgeJobOpts = {},
  ): FleetChatBridgeJob {
    if (!bridgeRecord(bridgeId)) throw new Error("unknown bridge");
    const parsed = parseFleetChatJobPayload(payload);
    if (!parsed) throw new Error("invalid fleet chat payload");
    const job: FleetChatBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "fleet-chat",
      payload: parsed,
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as FleetChatBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  pollJobs(bridgeId: string): BridgeJob[] {
    const now = Date.now();
    this.reconcile(now);
    const deliver: BridgeJob[] = [];

    for (const record of this.jobs.values()) {
      if (record.bridgeId !== bridgeId) continue;
      if (record.cancelRequestedAt) continue;
      if (record.status === "cancelled" || record.status === "succeeded" || record.status === "failed") continue;

      if (record.status === "queued") {
        record.status = "running";
        record.startedAt = now;
        record.attempt += 1;
        record.deliveryCount += 1;
        record.lastDeliveredAt = now;
        record.generation = (record.generation ?? 0) + 1;
        record.updatedAt = now;
        deliver.push({ ...record.job, generation: record.generation });
      }
    }

    if (deliver.length) this.persistJobs();
    return deliver;
  }

  cancelRequests(bridgeId: string): string[] {
    return [...this.jobs.values()]
      .filter((record) => record.bridgeId === bridgeId && record.cancelRequestedAt && !isTerminal(record.status))
      .map((record) => record.id);
  }

  cancelJob(jobId: string): BridgeJobRecord | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    if (isTerminal(record.status)) return record;
    const now = Date.now();
    record.cancelRequestedAt = now;
    if (record.status === "queued") {
      record.status = "cancelled";
      record.finishedAt = now;
      record.error = "cancelled";
    }
    this.touchRecord(record, now);
    return record;
  }

  storeResult(result: BridgeJobResult): boolean {
    const record = this.jobs.get(result.jobId);
    if (!record) return false;
    if (record.bridgeId !== result.bridgeId) return false;
    if (isTerminal(record.status)) return false;
    if (result.generation == null || result.generation !== record.generation) return false;

    const now = Date.now();
    record.result = result;
    record.finishedAt = now;
    if (record.cancelRequestedAt) {
      record.status = "cancelled";
      record.error = "cancelled";
    } else {
      record.status = result.exitCode === 0 ? "succeeded" : "failed";
      if (record.status === "failed") {
        record.error = result.stderr.trim() || result.stdout.trim() || "bridge job failed";
      }
    }
    this.touchRecord(record, now);
    return true;
  }

  result(jobId: string): BridgeJobResult | null {
    const record = this.jobs.get(jobId);
    return record?.result ?? null;
  }

  jobStatus(jobId: string): BridgeJobStatus | null {
    return this.jobs.get(jobId)?.status ?? null;
  }
}
