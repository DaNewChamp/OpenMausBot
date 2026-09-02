// The companion build must land a flat dist-companion/ tree that VPS deploy,
// electron-builder, and start-sidecar.sh can run without walking back into the
// repo checkout. Copying dist-companion out of the repo is load-bearing: inside
// the checkout, ../../shared still resolves and hides broken deploy layouts.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist-companion");

function runCompanionBuild(): void {
  const tsc = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "lib", "tsc.js"),
      "-p",
      "tsconfig.companion.build.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (tsc.status !== 0) {
    throw new Error(tsc.stderr || tsc.stdout || "companion tsc failed");
  }

  const layout = spawnSync(process.execPath, ["scripts/fix-companion-layout.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  if (layout.status !== 0) {
    throw new Error(layout.stderr || layout.stdout || "companion layout failed");
  }
}

function sourceTreeHasEmittedJs(dir: string): boolean {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      if (sourceTreeHasEmittedJs(path)) return true;
      continue;
    }
    if (name.name.endsWith(".js") && !name.name.endsWith(".test.js") && !name.name.endsWith(".mjs")) {
      return true;
    }
  }
  return false;
}

describe("companion build contract", () => {
  beforeAll(() => {
    runCompanionBuild();
  });

  it("emits a flat runtime tree with vendored shared/server modules", () => {
    expect(existsSync(join(dist, "index.js"))).toBe(true);
    expect(existsSync(join(dist, "shared", "hub-identity.mjs"))).toBe(true);
    expect(existsSync(join(dist, "shared", "fleet-presentation.js"))).toBe(true);
    expect(existsSync(join(dist, "server", "pairing-invitations.js"))).toBe(true);
    expect(existsSync(join(dist, "server", "atomic.js"))).toBe(true);
    expect(existsSync(join(dist, "companion", "src", "index.js"))).toBe(false);
  });

  it("removes stale orphans during layout", () => {
    const tsc = spawnSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "lib", "tsc.js"),
        "-p",
        "tsconfig.companion.build.json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(tsc.status).toBe(0);

    const orphans = [
      join(dist, "stale-orphan.js"),
      join(dist, "shared", "stale-shared-orphan.js"),
      join(dist, "server", "stale-server-orphan.js"),
    ];
    for (const orphan of orphans) {
      writeFileSync(orphan, "throw new Error('stale');\n");
    }

    const layout = spawnSync(process.execPath, ["scripts/fix-companion-layout.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(layout.status).toBe(0);
    expect(layout.stderr).toBe("");
    for (const orphan of orphans) {
      expect(existsSync(orphan)).toBe(false);
    }
  });

  it("does not emit JavaScript beside the companion build inputs", () => {
    expect(sourceTreeHasEmittedJs(join(root, "companion", "src"))).toBe(false);
    expect(existsSync(join(root, "shared", "fleet-presentation.js"))).toBe(false);
    expect(existsSync(join(root, "server", "pairing-invitations.js"))).toBe(false);
    expect(existsSync(join(root, "server", "atomic.js"))).toBe(false);
  });

  it("starts from a copied dist-companion tree with no repo ancestors in reach", () => {
    const staging = mkdtempSync(join(tmpdir(), "omb-companion-smoke-"));
    try {
      cpSync(dist, join(staging, "companion"), { recursive: true });
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import('./companion/shared/hub-identity.mjs');
           await import('./companion/shared/fleet-presentation.js');
           await import('./companion/server/pairing-invitations.js');`,
        ],
        { cwd: staging, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
