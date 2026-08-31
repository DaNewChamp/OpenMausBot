import { describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
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

  it("rejects duplicate --stdin and never invokes the verifier", async () => {
    const deps = baseDependencies();
    await expect(runVbotctl([
      "--data-dir", deps.dataDir,
      "account", "verify-code", "--email", "owner@example.com", "--stdin", "--stdin",
    ], deps)).resolves.toBe(2);
    expect(deps.service.verifyCode).not.toHaveBeenCalled();
    expect(deps.io.read().stderr).toContain("duplicate --stdin");
  });

  it("rejects every duplicate email and name occurrence, including value-less and mixed forms", async () => {
    const cases: Array<{ argv: string[]; message: string }> = [
      {
        argv: ["account", "request-code", "--email", "owner@example.com", "--email"],
        message: "duplicate --email",
      },
      {
        argv: ["account", "request-code", "--email", "--email", "owner@example.com"],
        message: "duplicate --email",
      },
      {
        argv: ["account", "request-code", "--email=owner@example.com", "--email", "other@example.com"],
        message: "duplicate --email",
      },
      {
        argv: ["hub", "register", "--name", "Home Hub", "--name"],
        message: "duplicate --name",
      },
      {
        argv: ["hub", "register", "--name=Home Hub", "--name", "Other Hub"],
        message: "duplicate --name",
      },
    ];
    for (const { argv, message } of cases) {
      const deps = baseDependencies();
      await expect(runVbotctl(["--data-dir", deps.dataDir, ...argv], deps)).resolves.toBe(2);
      expect(deps.service.requestCode).not.toHaveBeenCalled();
      expect(deps.service.register).not.toHaveBeenCalled();
      expect(deps.io.read().stderr).toContain(message);
    }
  });

  it("rejects a value-less email or name as a usage error", async () => {
    const emailDeps = baseDependencies();
    await expect(runVbotctl([
      "--data-dir", emailDeps.dataDir,
      "account", "request-code", "--email",
    ], emailDeps)).resolves.toBe(2);
    expect(emailDeps.io.read().stderr).toContain("missing --email");

    const nameDeps = baseDependencies();
    await expect(runVbotctl([
      "--data-dir", nameDeps.dataDir,
      "hub", "register", "--name",
    ], nameDeps)).resolves.toBe(2);
    expect(nameDeps.io.read().stderr).toContain("missing --name");
  });

  it("caps stdin and prompt input without echoing the supplied value", async () => {
    const stdinDeps = baseDependencies();
    const oversizedStdin = "SECRET-" + "x".repeat(80);
    stdinDeps.stdin = Readable.from([oversizedStdin]);
    await expect(runVbotctl([
      "--data-dir", stdinDeps.dataDir,
      "account", "verify-code", "--email", "owner@example.com", "--stdin",
    ], stdinDeps)).resolves.toBe(1);
    expect(stdinDeps.service.verifyCode).not.toHaveBeenCalled();
    expect(stdinDeps.io.read().stderr).toContain("verification code is too long");
    expect(stdinDeps.io.read().stderr).not.toContain(oversizedStdin);

    const promptDeps = baseDependencies();
    const oversizedPrompt = "SECRET-" + "y".repeat(80);
    promptDeps.prompt = vi.fn(async () => oversizedPrompt);
    await expect(runVbotctl([
      "--data-dir", promptDeps.dataDir,
      "account", "verify-code", "--email", "owner@example.com",
    ], promptDeps)).resolves.toBe(1);
    expect(promptDeps.service.verifyCode).not.toHaveBeenCalled();
    expect(promptDeps.io.read().stderr).not.toContain(oversizedPrompt);
  });

  it("allowlists emitted error codes and genericizes unknown values", async () => {
    const service = serviceFixture();
    service.verifyCode.mockRejectedValue({ code: "arbitrary_secret_code" });
    const deps = baseDependencies(service);
    await expect(runVbotctl([
      "--data-dir", deps.dataDir,
      "account", "verify-code", "--email", "owner@example.com",
    ], deps)).resolves.toBe(1);
    expect(deps.io.read().stderr).toBe("command failed\n");

    const safeService = serviceFixture();
    safeService.verifyCode.mockRejectedValue({ code: "invalid_otp" });
    const safeDeps = baseDependencies(safeService);
    await expect(runVbotctl([
      "--data-dir", safeDeps.dataDir,
      "account", "verify-code", "--email", "owner@example.com",
    ], safeDeps)).resolves.toBe(1);
    expect(safeDeps.io.read().stderr).toBe("invalid_otp\n");
  });

  it("checks the secret store before minting a missing hub identity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "vbot-cli-preflight-"));
    const io = makeIo();
    const readIdentity = vi.fn(() => ({ schemaVersion: 1, id: "hub-id", createdAt: 1 }));
    const createSecretStore = vi.fn(() => ({
      read: () => ({ status: "unavailable", values: {}, error: "corrupt" }),
      set: vi.fn(),
      delete: vi.fn(),
    }));
    const createService = vi.fn(() => serviceFixture());
    const deps = {
      ...io,
      service: undefined,
      readIdentity,
      createSecretStore,
      createService,
      createClient: vi.fn(() => ({})),
      io,
    };
    await expect(runVbotctl([
      "--data-dir", dataDir,
      "account", "request-code", "--email", "owner@example.com",
    ], deps)).resolves.toBe(1);
    expect(readIdentity).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "hub.json"))).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a symlink data directory before initializing secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "vbot-cli-symlink-"));
    const target = join(root, "target");
    const link = join(root, "link");
    symlinkSync(target, link);
    const deps = { ...baseDependencies(), service: undefined, dataDir: link };
    await expect(runVbotctl([
      "--data-dir", link,
      "account", "request-code", "--email", "owner@example.com",
    ], deps)).resolves.toBe(1);
    expect(deps.createSecretStore).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });

  it("repairs owner-only data-directory permissions before use", async () => {
    const deps = {
      ...baseDependencies(),
      service: undefined,
      createService: vi.fn(() => serviceFixture()),
    };
    chmodSync(deps.dataDir, 0o755);
    await expect(runVbotctl([
      "--data-dir", deps.dataDir,
      "account", "request-code", "--email", "owner@example.com",
    ], deps)).resolves.toBe(0);
    expect(statSync(deps.dataDir).mode & 0o777).toBe(0o700);
  });
});
