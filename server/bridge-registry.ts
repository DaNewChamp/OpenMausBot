import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export type BridgeCapability = "shell" | "local-vm" | "ssh-forward";

export interface BridgeRecord {
  id: string;
  name: string;
  tokenHash: string;
  capabilities: BridgeCapability[];
  createdAt: number;
  lastSeenAt: number;
  hostInfo?: string;
}

export type BridgeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type LocalVmBridgeJobKind = "local-vm-status" | "local-vm-action" | "local-vm-screenshot";

export interface LocalVmJobPayload {
  botId: string;
  action?: "run" | "stop" | "remove" | "recreate";
}

interface BridgeJobBase {
  id: string;
  bridgeId: string;
  timeoutMs: number;
  createdAt: number;
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

export type BridgeJob = ShellBridgeJob | LocalVmBridgeJob | SshBridgeJob;

export interface BridgeJobResult {
  jobId: string;
  bridgeId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  finishedAt: number;
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
    return JSON.parse(readFileSync(bridgesPath(), "utf8")) as BridgeStoreFile;
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
  if (!bridge.capabilities.includes(capability)) throw new Error(`bridge lacks ${capability} capability`);
  return bridge;
}

function isTerminal(status: BridgeJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export class BridgeRegistry {
  private pairing: PairingWindow | null = null;
  private jobs = new Map<string, BridgeJobRecord>();

  constructor() {
    for (const record of readJobsFile().jobs) {
      this.jobs.set(record.id, record);
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
        record.status = "cancelled";
        record.finishedAt = now;
        record.error = "cancelled";
        changed = true;
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

  list(): Omit<BridgeRecord, "tokenHash">[] {
    return readStore().bridges.map(({ tokenHash: _tokenHash, ...rest }) => rest);
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
    if (patch?.capabilities) bridge.capabilities = patch.capabilities;
    writeStore(store);
    return bridge;
  }

  revoke(bridgeId: string): boolean {
    const store = readStore();
    const next = store.bridges.filter((b) => b.id !== bridgeId);
    if (next.length === store.bridges.length) return false;
    writeStore({ bridges: next });
    return true;
  }

  getJob(jobId: string): BridgeJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(bridgeId?: string): BridgeJobRecord[] {
    const jobs = [...this.jobs.values()];
    return bridgeId ? jobs.filter((job) => job.bridgeId === bridgeId) : jobs;
  }

  private enqueueRecord(
    bridgeId: string,
    job: BridgeJob,
    opts: EnqueueBridgeJobOpts = {},
  ): BridgeJobRecord {
    const now = Date.now();
    if (opts.idempotencyKey) {
      const existing = this.findByIdempotencyKey(bridgeId, opts.idempotencyKey, now);
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
    const now = Date.now();
    if (opts.idempotencyKey) {
      const existing = this.findByIdempotencyKey(bridgeId, opts.idempotencyKey, now);
      if (existing) return existing.job as ShellBridgeJob;
    }
    const job: ShellBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "shell",
      command,
      cwd,
      timeoutMs,
      createdAt: Date.now(),
    };
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
    const now = Date.now();
    if (opts.idempotencyKey) {
      const existing = this.findByIdempotencyKey(bridgeId, opts.idempotencyKey, now);
      if (existing) return existing.job as LocalVmBridgeJob;
    }
    const job: LocalVmBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind,
      payload,
      timeoutMs,
      createdAt: Date.now(),
    };
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
    const now = Date.now();
    if (opts.idempotencyKey) {
      const existing = this.findByIdempotencyKey(bridgeId, opts.idempotencyKey, now);
      if (existing) return existing.job as SshBridgeJob;
    }
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
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  pollJobs(bridgeId: string): BridgeJob[] {
    const now = Date.now();
    this.reconcile(now);
    const deliver: BridgeJob[] = [];

    for (const record of this.jobs.values()) {
      if (record.bridgeId !== bridgeId) continue;
      if (record.status === "cancelled" || record.status === "succeeded" || record.status === "failed") continue;

      if (record.status === "queued") {
        record.status = "running";
        record.startedAt = now;
        record.attempt += 1;
        record.deliveryCount += 1;
        record.lastDeliveredAt = now;
        deliver.push(record.job);
        continue;
      }

      if (record.status === "running") {
        const stale =
          record.lastDeliveredAt != null && now - record.lastDeliveredAt >= STALE_RUNNING_MS;
        if (stale && record.attempt < record.maxAttempts) {
          record.attempt += 1;
          record.deliveryCount += 1;
          record.lastDeliveredAt = now;
          deliver.push(record.job);
        }
      }
    }

    if (deliver.length) this.persistJobs();
    return deliver;
  }

  cancelJob(jobId: string): BridgeJobRecord | null {
    const record = this.jobs.get(jobId);
    if (!record) return null;
    if (isTerminal(record.status)) return record;
    const now = Date.now();
    record.cancelRequestedAt = now;
    record.status = "cancelled";
    record.finishedAt = now;
    record.error = "cancelled";
    this.touchRecord(record, now);
    return record;
  }

  storeResult(result: BridgeJobResult): boolean {
    const record = this.jobs.get(result.jobId);
    if (!record) {
      this.jobs.set(result.jobId, {
        id: result.jobId,
        bridgeId: result.bridgeId,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        job: {
          id: result.jobId,
          bridgeId: result.bridgeId,
          kind: "shell",
          command: "",
          timeoutMs: 60_000,
          createdAt: result.finishedAt,
        },
        createdAt: result.finishedAt,
        updatedAt: result.finishedAt,
        finishedAt: result.finishedAt,
        attempt: 1,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        deliveryCount: 1,
        result,
        error: result.exitCode === 0 ? undefined : "bridge job failed",
      });
      this.persistJobs();
      return true;
    }

    if (isTerminal(record.status)) return false;

    const now = Date.now();
    record.result = result;
    record.finishedAt = now;
    record.status = result.exitCode === 0 ? "succeeded" : "failed";
    if (record.status === "failed") {
      record.error = result.stderr.trim() || result.stdout.trim() || "bridge job failed";
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
