import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildManifest } from "./backup-openmausbot-cloud.mjs";

describe("cloud backup manifest", () => {
  it("captures bot hierarchy", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-backup-"));
    const bots = [
      { id: "chief", name: "Chief Keef", title: "Chief of Staff", chiefOfStaff: true, section: "Work" },
      { id: "cio", name: "CIO", title: "Chief of Investments", section: "Work", reportsToBotId: "chief" },
      { id: "ada", name: "Ada", title: "Analyst", section: "Work", reportsToBotId: "cio" },
    ];
    writeFileSync(join(dir, "bots.json"), `${JSON.stringify(bots)}\n`);
    mkdirSync(join(dir, "workspaces"), { recursive: true });

    const manifest = buildManifest({
      dataPath: dir,
      companionPath: join(dir, "missing"),
      host: "test-host",
      stamp: "2026-08-29T03:15:00Z",
      includeCompanion: false,
      hostLabel: "test",
    });

    expect(manifest.botCount).toBe(3);
    expect(manifest.hierarchy.chiefBotId).toBe("chief");
    expect(manifest.hierarchy.tree.map((row) => [row.name, row.depth])).toEqual([
      ["CIO", 0],
      ["Ada", 1],
    ]);
  });
});
