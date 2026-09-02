#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHermesBotEngine } from "./hermes.ts";

const LIVE_ROOT = process.env.HERMES_LIVE_SRC_ROOT?.trim() || "";
const LIVE_HERMES_HOME = process.env.HERMES_LIVE_HERMES_HOME?.trim()
  || (LIVE_ROOT ? realpathSync(join(LIVE_ROOT, "..")) : "");
const LIVE_ENTRY = LIVE_ROOT ? join(LIVE_ROOT, "tui_gateway", "entry.py") : "";
const LIVE_ENABLED = process.env.HERMES_LIVE_SMOKE === "1" && LIVE_ROOT.length > 0 && existsSync(LIVE_ENTRY);

function liveHermesCli(): string {
  for (const candidate of [
    join(LIVE_ROOT, "venv", "bin", "hermes"),
    join(LIVE_ROOT, ".venv", "bin", "hermes"),
    join(LIVE_ROOT, "bin", "hermes"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "hermes";
}

function livePython(): string | undefined {
  for (const candidate of [
    join(LIVE_ROOT, "venv", "bin", "python3"),
    join(LIVE_ROOT, ".venv", "bin", "python3"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

(LIVE_ENABLED ? describe : describe.skip)("Hermes live gateway smoke", () => {
  it("discovers installed Hermes without profiles.list method-not-found", async () => {
    const python = livePython();
    if (!python) {
      throw new Error(`live gateway smoke requires python under ${LIVE_ROOT}/venv`);
    }
    const engine = createHermesBotEngine({
      cli: liveHermesCli(),
      cwd: LIVE_ROOT,
      environment: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HERMES_PYTHON_SRC_ROOT: LIVE_ROOT,
        HERMES_HOME: LIVE_HERMES_HOME,
        HERMES_PYTHON: python,
        HERMES_CWD: LIVE_ROOT,
      },
      timeouts: {
        initializationMs: 15_000,
        requestMs: 30_000,
        turnMs: 120_000,
        reconnectMs: 10_000,
      },
    });

    try {
      const discovery = await engine.discover();
      expect(discovery.state).toBe("available");
      expect(discovery.reason).toBeUndefined();
      expect(discovery.profiles.length).toBeGreaterThan(0);
      expect(discovery.profiles.some((row) => row.handle === "hermes" && row.availability === "available")).toBe(true);
      expect(discovery.capabilities.roster).toBe(true);
      expect(JSON.stringify(discovery)).not.toMatch(/method-not-found|unknown method|-32601/i);
    } finally {
      await engine.close();
    }
  }, 45_000);
});
