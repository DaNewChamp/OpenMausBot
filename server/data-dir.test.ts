import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

describe("DATA_DIR resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("prefers OMB_DATA_DIR over OMB_USER_DATA and the default homedir path", async () => {
    vi.resetModules();
    vi.stubEnv("OMB_DATA_DIR", "/tmp/omb-test-data-dir");
    vi.stubEnv("OMB_USER_DATA", "/tmp/omb-user-data");
    const { DATA_DIR } = await import("./data-dir.ts");
    expect(DATA_DIR).toBe("/tmp/omb-test-data-dir");
  });

  it("falls back to OMB_USER_DATA when OMB_DATA_DIR is unset", async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("OMB_USER_DATA", "/tmp/omb-user-data-only");
    const { DATA_DIR } = await import("./data-dir.ts");
    expect(DATA_DIR).toBe("/tmp/omb-user-data-only");
  });

  it("defaults to ~/.openmausbot when no override env vars are set", async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    const { DATA_DIR } = await import("./data-dir.ts");
    expect(DATA_DIR).toBe(join(homedir(), ".openmausbot"));
  });
});
