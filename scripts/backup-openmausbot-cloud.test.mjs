import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "vitest";

import { buildManifest } from "./backup-openmausbot-cloud.mjs";

it("buildManifest captures bot hierarchy", () => {
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

  assert.equal(manifest.botCount, 3);
  assert.equal(manifest.hierarchy.chiefBotId, "chief");
  assert.deepEqual(
    manifest.hierarchy.tree.map((row) => [row.name, row.depth]),
    [
      ["CIO", 0],
      ["Ada", 1],
    ],
  );
});
