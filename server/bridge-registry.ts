import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export type BridgeCapability = "shell" | "local-vm" | "ssh-forward" | "peekaboo";

export interface BridgeRecord {
  id: string;
  name: string;
  tokenHash: string;
  previousTokenHash?: string;
  previousTokenExpiresAt?: number;
  capabilities: BridgeCapability[];
  /** Capabilities accepted at pair (or later admin grant). Heartbeat cannot widen past this. */
  grantedCapabilities: BridgeCapability[];
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

export interface PeekabooBridgeJob extends BridgeJobBase {
  kind: "peekaboo-observe";
  payload: PeekabooJobPayload;
}

export type BridgeJob = ShellBridgeJob | LocalVmBridgeJob | SshBridgeJob | PeekabooBridgeJob;

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
  nextEligibleAt?: number;
  generation: number;
  claimedBy?: string;
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

export type StoreBridgeResultStatus = "accepted" | "duplicate" | "missing" | "foreign" | "stale";

const PAIRING_TTL_MS = 120_000;
const MAX_PAIRING_ATTEMPTS = 5;
const QUEUED_JOB_TTL_MS = 30 * 60_000;
const TERMINAL_JOB_RETENTION_MS = 24 * 60 * 60_000;
export const STALE_RUNNING_MS = 30_000;
const JOB_STORE_MAX = 500;
const DEFAULT_MAX_ATTEMPTS = 3;
const IDEMPOTENCY_WINDOW_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 30_000;
const TOKEN_OVERLAP_MS = 5 * 60_000;
const DEFAULT_WORKER_ID = "default";

/** Set when `bridge-jobs.json` is unreadable. Evidence is quarantined; the harness starts empty. */
export let lastJobsFileDiagnostic: string | null = null;

/** First reconnect is immediate; later attempts double 1s → 2s → 4s … capped. */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** (attempt - 2));
}

export class IdempotencyConflictError extends Error {
  readonly status = 409;
  constructor() {
    super("idempotency key conflict");
    this.name = "IdempotencyConflictError";
  }
}

export function jobFingerprint(job: BridgeJob): string {
  if (job.kind === "shell") {
    return JSON.stringify({ kind: "shell", command: job.command, cwd: job.cwd ?? "", timeoutMs: job.timeoutMs });
  }
  if (job.kind === "ssh-exec") {
    return JSON.stringify({
      kind: "ssh-exec",
      alias: job.alias,
      command: job.command,
      cwd: job.cwd ?? "",
      timeoutMs: job.timeoutMs,
    });
  }
  if (job.kind === "peekaboo-observe") {
    return JSON.stringify({ kind: job.kind, payload: job.payload, timeoutMs: job.timeoutMs });
  }
  return JSON.stringify({ kind: job.kind, payload: job.payload, timeoutMs: job.timeoutMs });
}

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

function normalizeBridge(bridge: BridgeRecord): BridgeRecord {
  return {
    ...bridge,
    grantedCapabilities: Array.isArray(bridge.grantedCapabilities)
      ? bridge.grantedCapabilities
      : [...(bridge.capabilities ?? [])],
  };
}

function readStore(): BridgeStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(bridgesPath(), "utf8")) as BridgeStoreFile;
    return { bridges: (parsed.bridges ?? []).map(normalizeBridge) };
  } catch {
    return { bridges: [] };
  }
}

function quarantineJobsFile(reason: string): void {
  const src = bridgeJobsPath();
  lastJobsFileDiagnostic = reason;
  if (!existsSync(src)) return;
  const dest = join(DATA_DIR, `bridge-jobs.json.corrupt-${Date.now()}`);
  try {
    copyFileSync(src, dest);
    renameSync(src, `${src}.quarantined`);
  } catch (error) {
    lastJobsFileDiagnostic = `${reason}; quarantine failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  console.error(`bridge-jobs.json unreadable (${reason}); quarantined evidence at ${dest}`);
}

function readJobsFile(): BridgeJobsFile {
  lastJobsFileDiagnostic = null;
  const path = bridgeJobsPath();
  if (!existsSync(path)) return { jobs: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    quarantineJobsFile(`read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { jobs: [] };
  }
  try {
    const parsed = JSON.parse(raw) as BridgeJobsFile;
    if (!parsed || !Array.isArray(parsed.jobs)) {
      quarantineJobsFile("jobs array missing");
      return { jobs: [] };
    }
    return parsed;
  } catch (error) {
    quarantineJobsFile(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
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

function workerKey(bridgeId: string, workerId: string): string {
  return `${bridgeId}:${workerId}`;
}

export class BridgeRegistry {
  private pairing: PairingWindow | null = null;
  private jobs = new Map<string, BridgeJobRecord>();
  private workerSeen = new Map<string, number>();
  private pendingNextToken = new Map<string, string>();

  constructor() {
    for (const record of readJobsFile().jobs) {
      this.jobs.set(record.id, {
        ...record,
        generation: record.generation ?? record.deliveryCount ?? 0,
      });
    }
    this.pruneJobs(Date.now());
  }

  jobsFileDiagnostic(): string | null {
    return lastJobsFileDiagnostic;
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

  private workerStale(bridgeId: string, workerId: string | undefined, now: number): boolean {
    const id = workerId || DEFAULT_WORKER_ID;
    const seen = this.workerSeen.get(workerKey(bridgeId, id));
    if (seen == null) {
      const bridge = bridgeRecord(bridgeId);
      return !bridge || now - bridge.lastSeenAt > STALE_RUNNING_MS;
    }
    return now - seen > STALE_RUNNING_MS;
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
        const started = record.startedAt ?? record.createdAt;
        const pastDeadline = now > started + record.job.timeoutMs + STALE_RUNNING_MS;
        const ownerGone = this.workerStale(record.bridgeId, record.claimedBy, now);
        if (ownerGone || pastDeadline) {
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

        const staleDelivery =
          record.lastDeliveredAt != null && now - record.lastDeliveredAt > STALE_RUNNING_MS;
        const ownerGone = this.workerStale(record.bridgeId, record.claimedBy, now);
        if (ownerGone && staleDelivery) {
          if (record.attempt >= record.maxAttempts) {
            record.status = "failed";
            record.finishedAt = now;
            record.error = "bridge offline; retry attempts exhausted";
          } else {
            record.status = "queued";
            record.startedAt = undefined;
            record.lastDeliveredAt = undefined;
            record.claimedBy = undefined;
            record.nextEligibleAt = now + retryDelayMs(record.attempt);
          }
          changed = true;
        }
      }
    }
    if (changed) this.persistJobs();
  }

  list(): Array<Omit<BridgeRecord, "tokenHash" | "previousTokenHash"> & { online: boolean }> {
    const now = Date.now();
    return readStore().bridges.map(({ tokenHash: _tokenHash, previousTokenHash: _prev, ...rest }) => ({
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
    const caps = input.capabilities ?? [];
    const record: BridgeRecord = {
      id: randomUUID(),
      name: input.name.trim() || "bridge",
      tokenHash: hashToken(bridgeToken),
      capabilities: caps,
      grantedCapabilities: [...caps],
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
    const now = Date.now();
    const store = readStore();
    return (
      store.bridges.find((b) => {
        if (safeEqual(b.tokenHash, digest)) return true;
        if (
          b.previousTokenHash &&
          b.previousTokenExpiresAt &&
          now < b.previousTokenExpiresAt &&
          safeEqual(b.previousTokenHash, digest)
        ) {
          return true;
        }
        return false;
      }) ?? null
    );
  }

  touch(
    bridgeId: string,
    patch?: {
      hostInfo?: string;
      capabilities?: BridgeCapability[];
      workerId?: string;
      inFlight?: string[];
    },
  ): BridgeRecord | null {
    const store = readStore();
    const bridge = store.bridges.find((b) => b.id === bridgeId);
    if (!bridge) return null;
    const now = Date.now();
    bridge.lastSeenAt = now;
    if (patch?.hostInfo) bridge.hostInfo = patch.hostInfo;
    if (patch?.capabilities) {
      const granted = new Set(bridge.grantedCapabilities ?? bridge.capabilities);
      bridge.capabilities = patch.capabilities.filter((capability) => granted.has(capability));
    }
    writeStore(store);
    const workerId = patch?.workerId?.trim() || DEFAULT_WORKER_ID;
    this.workerSeen.set(workerKey(bridgeId, workerId), now);
    if (patch?.inFlight) {
      for (const jobId of patch.inFlight) {
        const record = this.jobs.get(jobId);
        if (!record || record.bridgeId !== bridgeId || record.status !== "running") continue;
        if (record.claimedBy && record.claimedBy !== workerId) continue;
        record.lastDeliveredAt = now;
        record.claimedBy = workerId;
      }
    }
    return bridge;
  }

  rotateToken(bridgeId: string): { bridgeToken: string } | null {
    const store = readStore();
    const bridge = store.bridges.find((b) => b.id === bridgeId);
    if (!bridge) return null;
    const now = Date.now();
    const next = randomBytes(24).toString("hex");
    bridge.previousTokenHash = bridge.tokenHash;
    bridge.previousTokenExpiresAt = now + TOKEN_OVERLAP_MS;
    bridge.tokenHash = hashToken(next);
    writeStore(store);
    this.pendingNextToken.set(bridgeId, next);
    return { bridgeToken: next };
  }

  takePendingToken(bridgeId: string): string | undefined {
    const token = this.pendingNextToken.get(bridgeId);
    if (!token) return undefined;
    this.pendingNextToken.delete(bridgeId);
    return token;
  }

  revoke(bridgeId: string): boolean {
    const store = readStore();
    const next = store.bridges.filter((b) => b.id !== bridgeId);
    if (next.length === store.bridges.length) return false;
    writeStore({ bridges: next });
    this.pendingNextToken.delete(bridgeId);
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

  enqueuePeekaboo(
    bridgeId: string,
    payload: PeekabooJobPayload,
    timeoutMs = 60_000,
    opts: EnqueueBridgeJobOpts = {},
  ): PeekabooBridgeJob {
    requireCapability(bridgeId, "peekaboo");
    const job: PeekabooBridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "peekaboo-observe",
      payload,
      timeoutMs,
      createdAt: Date.now(),
    };
    if (opts.idempotencyKey) {
      const existing = this.existingIdempotent(bridgeId, opts.idempotencyKey, jobFingerprint(job), Date.now());
      if (existing) return existing.job as PeekabooBridgeJob;
    }
    this.enqueueRecord(bridgeId, job, opts);
    return job;
  }

  pollJobs(bridgeId: string, workerId = DEFAULT_WORKER_ID): BridgeJob[] {
    const now = Date.now();
    this.reconcile(now);
    const deliver: BridgeJob[] = [];
    const worker = workerId.trim() || DEFAULT_WORKER_ID;
    this.workerSeen.set(workerKey(bridgeId, worker), now);

    for (const record of this.jobs.values()) {
      if (record.bridgeId !== bridgeId) continue;
      if (record.cancelRequestedAt) continue;
      if (record.status !== "queued") continue;
      if (record.nextEligibleAt != null && now < record.nextEligibleAt) continue;

      record.status = "running";
      record.startedAt = now;
      record.attempt += 1;
      record.deliveryCount += 1;
      record.lastDeliveredAt = now;
      record.claimedBy = worker;
      record.generation = (record.generation ?? 0) + 1;
      record.nextEligibleAt = undefined;
      record.updatedAt = now;
      deliver.push({ ...record.job, generation: record.generation });
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

  storeResult(result: BridgeJobResult): StoreBridgeResultStatus {
    const record = this.jobs.get(result.jobId);
    if (!record) return "missing";
    if (record.bridgeId !== result.bridgeId) return "foreign";
    if (isTerminal(record.status)) return "duplicate";
    if (result.generation != null && record.generation && result.generation !== record.generation) {
      return "stale";
    }

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
    return "accepted";
  }

  result(jobId: string): BridgeJobResult | null {
    const record = this.jobs.get(jobId);
    return record?.result ?? null;
  }

  jobStatus(jobId: string): BridgeJobStatus | null {
    return this.jobs.get(jobId)?.status ?? null;
  }
}
