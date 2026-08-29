import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { relativizeCwd, resolvePortableCwd } from "./bot-cwd.ts";
import { applyHostProfile, exportHubArchive, importHubArchive } from "./hub-archive.ts";

describe("portable workspace cwds", () => {
  it("round-trips a cwd under the hub data dir", () => {
    const dataDir = "/var/lib/openmausbot";
    expect(relativizeCwd("/var/lib/openmausbot/workspaces/bot-1", dataDir)).toBe("${DATA_DIR}/workspaces/bot-1");
    expect(resolvePortableCwd("${DATA_DIR}/workspaces/bot-1", dataDir)).toBe("/var/lib/openmausbot/workspaces/bot-1");
  });

  it("leaves foreign host paths alone", () => {
    expect(relativizeCwd("/Users/vincent/work", "/var/lib/openmausbot")).toBe("/Users/vincent/work");
  });
});

describe("hub archive", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("exports grants and remaps cwds, then imports with a host profile", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-hub-src-"));
    const dest = mkdtempSync(join(tmpdir(), "omb-hub-dst-"));
    const imported = mkdtempSync(join(tmpdir(), "omb-hub-in-"));
    dirs.push(dataDir, dest, imported);
    mkdirSync(join(dataDir, "workspaces", "bot-1"), { recursive: true });
    writeFileSync(
      join(dataDir, "bots.json"),
      `${JSON.stringify([{ id: "bot-1", name: "Chief", cwd: join(dataDir, "workspaces", "bot-1"), alwaysAllow: ["bridge:run_on_bridge:hostname"] }], null, 2)}\n`,
    );
    writeFileSync(join(dataDir, "bridges.json"), `${JSON.stringify({ bridges: [{ id: "br-1", name: "mini", tokenHash: "abc", capabilities: [] }] }, null, 2)}\n`);
    writeFileSync(join(dataDir, "decisions.ndjson"), "{\"decision\":\"user-approved\"}\n");

    const manifest = exportHubArchive({ dataDir, destDir: dest, sourceHost: "test" });
    expect(manifest.files).toContain("bots.json");
    expect(manifest.files).toContain("decisions.ndjson");
    const exportedBots = JSON.parse(readFileSync(join(dest, "bots.json"), "utf8"));
    expect(exportedBots[0].cwd).toBe("${DATA_DIR}/workspaces/bot-1");
    expect(exportedBots[0].alwaysAllow).toEqual(["bridge:run_on_bridge:hostname"]);

    importHubArchive({
      archiveDir: dest,
      dataDir: imported,
      profile: {
        id: "servarica",
        dataDir: imported,
        botPatches: [{ id: "bot-1", computer: "cloud", cloudBackend: "vps" }],
        config: { vps: { sshAlias: "openmaus-docker" } },
      },
    });
    const importedBots = JSON.parse(readFileSync(join(imported, "bots.json"), "utf8"));
    expect(importedBots[0].cwd).toBe(join(imported, "workspaces", "bot-1"));
    expect(importedBots[0].computer).toBe("cloud");
    expect(JSON.parse(readFileSync(join(imported, "config.json"), "utf8")).vps.sshAlias).toBe("openmaus-docker");
  });
});
