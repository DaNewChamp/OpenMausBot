import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadHermesBindings,
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
});
