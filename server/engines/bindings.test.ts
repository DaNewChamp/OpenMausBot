import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import * as atomic from "../atomic.ts";

import {
  clearHermesPendingProfile,
  loadHermesBindings,
  loadHermesPendingProfiles,
  markHermesPendingProfile,
  removeHermesBinding,
  setHermesBinding,
} from "./bindings.ts";
import type { HermesBotBinding } from "./contracts.ts";

describe("Hermes binding sidecar", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vbot-hermes-bindings-"));
    file = join(dir, "nested", "hermes-bindings.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const binding: HermesBotBinding = {
    adapter: "hermesBot",
    profile: "coder",
    canonicalTitle: "Bot Chat",
    bindingVersion: 1,
  };

  it("treats a missing sidecar as an available empty set", () => {
    const result = loadHermesBindings(file);
    expect(result).toMatchObject({ state: "available" });
    if (result.state === "available") expect([...result.value]).toEqual([]);
  });

  it("writes a valid sidecar atomically with private modes and round trips", () => {
    expect(setHermesBinding("bot-1", binding, file)).toEqual({ state: "available", value: undefined });
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadHermesBindings(file)).toMatchObject({ state: "available" });
    const bytes = readFileSync(file, "utf8");
    expect(JSON.parse(bytes)).toEqual({ version: 1, bindings: { "bot-1": binding } });
    expect(bytes).not.toMatch(/state\.db|HERMES_HOME|token|prompt|session/i);
  });

  it("loads multiple bindings and removes only the requested bot", () => {
    setHermesBinding("bot-1", binding, file);
    setHermesBinding("bot-2", { ...binding, profile: "writer" }, file);
    expect(removeHermesBinding("bot-1", file)).toEqual({ state: "available", value: undefined });
    const result = loadHermesBindings(file);
    expect(result).toMatchObject({ state: "available" });
    if (result.state === "available") expect([...result.value.entries()]).toEqual([["bot-2", { ...binding, profile: "writer" }]]);
  });

  it("does not turn an unreadable or malformed existing sidecar into an empty map", () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(file, "{not-json", { mode: 0o600 });
    expect(loadHermesBindings(file)).toMatchObject({ state: "unavailable" });
    chmodSync(file, 0o000);
    expect(loadHermesBindings(file)).toMatchObject({ state: "unavailable" });
  });

  it("rejects schema drift and unsafe binding fields without changing prior bytes", () => {
    setHermesBinding("bot-1", binding, file);
    const before = readFileSync(file);
    expect(setHermesBinding("bot-2", { ...binding, profile: "/secret/profile" }, file)).toMatchObject({ state: "unavailable" });
    expect(setHermesBinding("bot-2", { ...binding, canonicalTitle: "Other" as "Bot Chat" }, file)).toMatchObject({ state: "unavailable" });
    expect(setHermesBinding("bot-2", { ...binding, profile: "session-id" }, file)).toMatchObject({ state: "unavailable" });
    expect(readFileSync(file)).toEqual(before);
    writeFileSync(file, JSON.stringify({ version: 2, bindings: {} }), { mode: 0o600 });
    expect(loadHermesBindings(file)).toMatchObject({ state: "unavailable" });
  });

  it("preserves old bytes when a mutation cannot replace the target", () => {
    setHermesBinding("bot-1", binding, file);
    const before = readFileSync(file);
    const badTarget = join(dir, "nested", "replacement-target");
    mkdirSync(badTarget);
    expect(setHermesBinding("bot-2", binding, badTarget)).toMatchObject({ state: "unavailable" });
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(join(dir, "nested", "replacement-target"))).toBe(true);
  });

  it("preserves old bytes when atomic publication fails after rename", () => {
    setHermesBinding("bot-1", binding, file);
    const before = readFileSync(file);
    const original = atomic.writeFileAtomic;
    const publication = vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce((path, data, options) => {
      original(path, data, options);
      throw new Error("rename failed after publication");
    });
    expect(setHermesBinding("bot-2", binding, file)).toMatchObject({ state: "unavailable" });
    publication.mockRestore();
    expect(readFileSync(file)).toEqual(before);
  });

  it("serializes concurrent read-modify-write mutations without lost updates", async () => {
    const { execFile } = await import("node:child_process");
    const script = `
      import("./server/engines/bindings.ts").then(({ setHermesBinding }) => {
        const file = process.argv[1];
        const botId = process.argv[2];
        const result = setHermesBinding(botId, { adapter: "hermesBot", profile: botId, canonicalTitle: "Bot Chat", bindingVersion: 1 }, file);
        if (result.state !== "available") process.exitCode = 1;
      });
    `;
    const run = (botId: string) =>
      new Promise<number>((resolve) => {
        const proc = execFile(process.execPath, ["--experimental-strip-types", "-e", script, file, botId], {
          cwd: process.cwd(),
          env: process.env,
        });
        proc.on("exit", (code) => resolve(code ?? 1));
      });
    const codes = await Promise.all([run("alpha"), run("beta")]);
    expect(codes).toEqual([0, 0]);
    const result = loadHermesBindings(file);
    expect(result).toMatchObject({ state: "available" });
    if (result.state === "available") expect([...result.value.keys()]).toEqual(["alpha", "beta"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("stores only a profile-only pending marker and clears it after adoption", () => {
    const pending = join(dir, "nested", "hermes-pending.json");
    expect(markHermesPendingProfile("Coder", pending)).toEqual({ state: "available", value: true });
    expect(markHermesPendingProfile("coder", pending)).toEqual({ state: "available", value: false });
    expect(statSync(pending).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pending, "utf8"))).toEqual({ version: 1, profiles: ["coder"] });
    expect(readFileSync(pending, "utf8")).not.toMatch(/session|runtime|secret|token/i);
    expect(loadHermesPendingProfiles(pending)).toMatchObject({ state: "available" });
    expect(clearHermesPendingProfile("coder", pending)).toEqual({ state: "available", value: undefined });
    expect(existsSync(pending)).toBe(false);
  });

  it("rejects reserved and UUID-shaped pending profiles without changing prior bytes", () => {
    const pending = join(dir, "nested", "hermes-pending.json");
    expect(markHermesPendingProfile("coder", pending)).toMatchObject({ state: "available" });
    const before = readFileSync(pending);
    for (const profile of ["session-root", "root-session", "resolved_session", "0123456789abcdef", "01234567-89ab-cdef-0123-456789abcdef"]) {
      expect(markHermesPendingProfile(profile, pending)).toMatchObject({ state: "unavailable" });
    }
    expect(readFileSync(pending)).toEqual(before);
  });
});
