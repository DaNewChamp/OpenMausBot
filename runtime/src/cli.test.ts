import { describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runVbotctl } from "./cli.ts";

const makeIo = (input = "") => {
  let stdout = "";
  let stderr = "";
  const out = new Writable({ write(chunk, _encoding, callback) { stdout += String(chunk); callback(); } });
  const err = new Writable({ write(chunk, _encoding, callback) { stderr += String(chunk); callback(); } });
  return { stdin: Readable.from([input]), stdout: out, stderr: err, read: () => ({ stdout, stderr }) };
};

const state = { accountEmail: "owner@example.com", installationId: "installation-1", credentialExpiresAt: 123 };
const serviceFixture = () => ({
  requestCode: vi.fn(async (email: string) => ({ email })),
  verifyCode: vi.fn(async () => ({ accountEmail: "owner@example.com" })),
  register: vi.fn(async () => state),
  heartbeat: vi.fn(async () => {}),
  fleet: vi.fn(async () => [{ ...state, token: "leaked", nested: { password: "secret" } }]),
  stopPresence: vi.fn(),
  dispose: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
});

const baseDependencies = (service = serviceFixture()) => {
  const io = makeIo();
  const dataDir = mkdtempSync(join(tmpdir(), "vbot-cli-"));
  const deps = {
    ...io,
    dataDir,
    service,
    prompt: vi.fn(async () => "12345678"),
    readIdentity: vi.fn(() => ({ schemaVersion: 1, id: "hub-id", createdAt: 1 })),
    createSecretStore: vi.fn(() => ({ read: () => ({ status: "empty", values: {} }), set: vi.fn(), delete: vi.fn() })),
    createClient: vi.fn(() => ({})),
  };
  return { ...deps, io };
};

describe("vbotctl parser and output", () => {
  it("returns exit 2 for unknown commands and does not initialize dependencies", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl(["--data-dir", deps.dataDir, "wat"], deps)).resolves.toBe(2);
    expect(deps.createSecretStore).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it("returns exit 2 for missing or relative data directory before secrets/network", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl(["account", "request-code"], deps)).resolves.toBe(2);
    await expect(runVbotctl(["--data-dir", "relative", "account", "request-code", "--email", "owner@example.com"], deps)).resolves.toBe(2);
    expect(deps.createSecretStore).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it("reads verification through hidden prompt or stdin and never argv", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl(["--data-dir", deps.dataDir, "account", "verify-code", "--email", "owner@example.com"], deps)).resolves.toBe(0);
    expect(deps.prompt).toHaveBeenCalled();
    expect(deps.service.verifyCode).toHaveBeenCalledWith("owner@example.com", "12345678");
    const stdinDeps = baseDependencies();
    stdinDeps.stdin = Readable.from(["87654321\n"]);
    await expect(runVbotctl(["--data-dir", stdinDeps.dataDir, "account", "verify-code", "--email", "owner@example.com", "--stdin"], stdinDeps)).resolves.toBe(0);
    expect(stdinDeps.service.verifyCode).toHaveBeenCalledWith("owner@example.com", "87654321");
    await expect(runVbotctl(["--data-dir", deps.dataDir, "account", "verify-code", "--email", "owner@example.com", "--otp", "12345678"], deps)).resolves.toBe(2);
  });

  it("does not echo prompt or stdin contents in errors", async () => {
    const service = serviceFixture();
    service.verifyCode.mockRejectedValue(new Error("verification failed"));
    const deps = baseDependencies(service);
    deps.prompt = vi.fn(async () => "SECRET-OTP-12345678");
    const code = await runVbotctl(["--data-dir", deps.dataDir, "account", "verify-code", "--email", "owner@example.com"], deps);
    expect(code).toBe(1);
    expect(deps.io.read().stderr).not.toContain("SECRET-OTP-12345678");

    const stdinService = serviceFixture();
    stdinService.verifyCode.mockRejectedValue(new Error("verification failed"));
    const stdinDeps = baseDependencies(stdinService);
    stdinDeps.stdin = Readable.from(["SECRET-STDIN-87654321\n"]);
    await runVbotctl(["--data-dir", stdinDeps.dataDir, "account", "verify-code", "--email", "owner@example.com", "--stdin"], stdinDeps);
    expect(stdinDeps.io.read().stderr).not.toContain("SECRET-STDIN-87654321");
  });

  it("redacts unexpected credential-shaped fleet keys before JSON output", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl(["--data-dir", deps.dataDir, "fleet", "list", "--json"], deps)).resolves.toBe(0);
    const output = deps.io.read().stdout;
    expect(output).not.toContain("leaked");
    expect(output).not.toContain("secret");
    expect(output).toContain("[REDACTED]");
  });

  it("requires --once for heartbeat and rejects missing arguments", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl(["--data-dir", deps.dataDir, "hub", "heartbeat"], deps)).resolves.toBe(2);
    await expect(runVbotctl(["--data-dir", deps.dataDir, "hub", "register"], deps)).resolves.toBe(2);
    await expect(runVbotctl(["--data-dir", deps.dataDir, "account", "request-code"], deps)).resolves.toBe(2);
  });

  it("success output does not include credential fields", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl(["--data-dir", deps.dataDir, "hub", "register", "--name", "Home Hub"], deps)).resolves.toBe(0);
    expect(deps.io.read().stdout).not.toContain("signed.");
    expect(deps.io.read().stdout).not.toContain("omb_install_");
  });
});
