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

export interface BridgeJob {
  id: string;
  bridgeId: string;
  kind: "shell";
  command: string;
  cwd?: string;
  timeoutMs: number;
  createdAt: number;
}

export interface BridgeJobResult {
  jobId: string;
  bridgeId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  finishedAt: number;
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

const PAIRING_TTL_MS = 120_000;
const MAX_PAIRING_ATTEMPTS = 5;
const JOB_TTL_MS = 5 * 60_000;

function bridgesPath(): string {
  return join(DATA_DIR, "bridges.json");
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

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class BridgeRegistry {
  private pairing: PairingWindow | null = null;
  private pendingJobs = new Map<string, BridgeJob>();
  private results = new Map<string, BridgeJobResult>();

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
    capabilities: BridgeCapability[];
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
      capabilities: input.capabilities.length ? input.capabilities : ["shell"],
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

  touch(bridgeId: string, hostInfo?: string): BridgeRecord | null {
    const store = readStore();
    const bridge = store.bridges.find((b) => b.id === bridgeId);
    if (!bridge) return null;
    bridge.lastSeenAt = Date.now();
    if (hostInfo) bridge.hostInfo = hostInfo;
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

  enqueueShell(bridgeId: string, command: string, cwd?: string, timeoutMs = 60_000): BridgeJob {
    const job: BridgeJob = {
      id: randomUUID(),
      bridgeId,
      kind: "shell",
      command,
      cwd,
      timeoutMs,
      createdAt: Date.now(),
    };
    this.pendingJobs.set(job.id, job);
    return job;
  }

  pollJobs(bridgeId: string): BridgeJob[] {
    const now = Date.now();
    const jobs: BridgeJob[] = [];
    for (const [id, job] of this.pendingJobs) {
      if (job.bridgeId !== bridgeId) continue;
      if (now - job.createdAt > JOB_TTL_MS) {
        this.pendingJobs.delete(id);
        continue;
      }
      jobs.push(job);
      this.pendingJobs.delete(id);
    }
    return jobs;
  }

  storeResult(result: BridgeJobResult): void {
    this.results.set(result.jobId, result);
    if (this.results.size > 200) {
      const oldest = [...this.results.keys()].slice(0, 50);
      for (const id of oldest) this.results.delete(id);
    }
  }

  result(jobId: string): BridgeJobResult | null {
    return this.results.get(jobId) ?? null;
  }
}
