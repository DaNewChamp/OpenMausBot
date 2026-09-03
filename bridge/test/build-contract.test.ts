// The bridge build must land a flat dist-bridge/ tree that deploy-bridge can copy
// into ~/.openmausbot-bridge/runtime/bridge and run without walking back into the
// repo checkout. Copying dist-bridge out of the repo is load-bearing: inside the
// checkout, ../../shared still resolves and hides broken deploy layouts.
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist-bridge");
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function isNodeOrRelativeSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return true;
  if (nodeBuiltins.has(specifier)) return true;
  const base = specifier.startsWith("node:") ? specifier.slice(5).split("/")[0] : specifier.split("/")[0];
  return builtinModules.includes(base) || builtinModules.includes(`${base}/promises`);
}

function collectBareImports(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const imports: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    imports.push(match[1]);
  }
  return imports;
}

function assertNoBarePackageImports(treeRoot: string): void {
  const violations: string[] = [];
  for (const filePath of listJsFiles(treeRoot)) {
    for (const specifier of collectBareImports(filePath)) {
      if (!isNodeOrRelativeSpecifier(specifier)) {
        violations.push(`${filePath}: ${specifier}`);
      }
    }
  }
  expect(violations, violations.join("\n")).toEqual([]);
}

function runBridgeBuild(): void {
  const tsc = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "lib", "tsc.js"),
      "-p",
      "tsconfig.bridge.build.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (tsc.status !== 0) {
    throw new Error(tsc.stderr || tsc.stdout || "bridge tsc failed");
  }

  const layout = spawnSync(process.execPath, ["scripts/fix-bridge-layout.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  if (layout.status !== 0) {
    throw new Error(layout.stderr || layout.stdout || "bridge layout failed");
  }
}

function listJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      files.push(...listJsFiles(path));
      continue;
    }
    if (name.name.endsWith(".js")) files.push(path);
  }
  return files;
}

function collectRelativeImports(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const imports: string[] = [];
  const pattern = /(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    imports.push(match[1]);
  }
  return imports;
}

function resolveImport(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base)) return base;
  if (existsSync(`${base}.js`)) return `${base}.js`;
  if (existsSync(join(base, "index.js"))) return join(base, "index.js");
  return base;
}

function assertRelativeImportsResolve(treeRoot: string): void {
  const missing: string[] = [];
  for (const filePath of listJsFiles(treeRoot)) {
    for (const specifier of collectRelativeImports(filePath)) {
      const resolved = resolveImport(filePath, specifier);
      if (!existsSync(resolved)) {
        missing.push(`${filePath}: ${specifier} -> ${resolved}`);
      }
    }
  }
  expect(missing, missing.join("\n")).toEqual([]);
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

describe("bridge build contract", () => {
  beforeAll(() => {
    runBridgeBuild();
  });

  it("emits a flat runtime tree with vendored shared/server modules", () => {
    expect(existsSync(join(dist, "index.js"))).toBe(true);
    expect(existsSync(join(dist, "yaml.js"))).toBe(true);
    expect(existsSync(join(dist, "hermes.js"))).toBe(true);
    expect(existsSync(join(dist, "hermes-runtime.js"))).toBe(true);
    expect(existsSync(join(dist, "shared", "bridge-hermes-contract.js"))).toBe(true);
    expect(existsSync(join(dist, "server", "engines", "hermes.js"))).toBe(true);
    expect(existsSync(join(dist, "server", "drivers", "agents-proxy.js"))).toBe(true);
    expect(existsSync(join(dist, "server", "contracts.js"))).toBe(true);
    expect(existsSync(join(dist, "bridge", "src", "index.js"))).toBe(false);
  });

  it("removes stale orphans during layout", () => {
    const tsc = spawnSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "lib", "tsc.js"),
        "-p",
        "tsconfig.bridge.build.json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(tsc.status).toBe(0);

    const orphans = [
      join(dist, "stale-orphan.js"),
      join(dist, "shared", "stale-shared-orphan.js"),
      join(dist, "server", "stale-server-orphan.js"),
      join(dist, "server", "engines", "stale-nested-orphan.js"),
    ];
    mkdirSync(join(dist, "server", "engines"), { recursive: true });
    for (const orphan of orphans) {
      writeFileSync(orphan, "throw new Error('stale');\n");
    }

    const layout = spawnSync(process.execPath, ["scripts/fix-bridge-layout.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(layout.status).toBe(0);
    expect(layout.stderr).toBe("");
    for (const orphan of orphans) {
      expect(existsSync(orphan)).toBe(false);
    }
  });

  it("does not emit JavaScript beside the bridge build inputs", () => {
    expect(sourceTreeHasEmittedJs(join(root, "bridge", "src"))).toBe(false);
    expect(existsSync(join(root, "shared", "bridge-hermes-contract.js"))).toBe(false);
    expect(existsSync(join(root, "server", "contracts.js"))).toBe(false);
  });

  it("resolves every relative import in dist-bridge", () => {
    assertRelativeImportsResolve(dist);
  });

  it("has no bare non-node package imports in dist-bridge", () => {
    assertNoBarePackageImports(dist);
  });

  it("runs help and connect validation from an isolated copied tree with no node_modules", () => {
    const staging = mkdtempSync(join(tmpdir(), "omb-bridge-smoke-"));
    try {
      cpSync(dist, join(staging, "bridge"), { recursive: true });
      assertRelativeImportsResolve(join(staging, "bridge"));
      assertNoBarePackageImports(join(staging, "bridge"));

      const help = spawnSync(process.execPath, [join(staging, "bridge", "index.js")], {
        cwd: staging,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("openmausbot-bridge");
      expect(help.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);

      const connect = spawnSync(
        process.execPath,
        [join(staging, "bridge", "index.js"), "connect"],
        { cwd: staging, encoding: "utf8", timeout: 10_000 },
      );
      expect(connect.status).toBe(1);
      expect(connect.stderr).toMatch(/usage: connect --url/);
      expect(connect.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it("runs hermes-connector-install from an isolated copied tree without resolving yaml from the repo", () => {
    const staging = mkdtempSync(join(tmpdir(), "omb-bridge-yaml-smoke-"));
    try {
      const isolated = join(staging, "bridge");
      cpSync(dist, isolated, { recursive: true });
      expect(existsSync(join(isolated, "node_modules"))).toBe(false);
      const hermesHome = join(staging, "hermes-home");
      mkdirSync(hermesHome, { recursive: true, mode: 0o700 });
      writeFileSync(join(hermesHome, "config.yaml"), "model:\n  default: z-ai/glm-5.2\n");
      const sidecarPath = join(staging, "hermes-vbot-mcp.json");
      const installed = spawnSync(
        process.execPath,
        [
          join(isolated, "index.js"),
          "hermes-connector-install",
          "--hub",
          "Mac mini",
          "--bot-scope",
          "bot-chief",
          "--profile-home",
          hermesHome,
          "--config",
          sidecarPath,
          "--socket",
          join(staging, "vbot.sock"),
        ],
        {
          cwd: staging,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: staging,
            USERPROFILE: staging,
          },
        },
      );
      expect(installed.status, installed.stderr || installed.stdout).toBe(0);
      expect(installed.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package 'yaml'|Cannot find module 'yaml'/i);
      expect(installed.stdout).toMatch(/installed Hermes V Bot connector/);
      const yamlText = readFileSync(join(hermesHome, "config.yaml"), "utf8");
      expect(yamlText).toMatch(/mcp_servers:/);
      expect(yamlText).toContain("bot-chief");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
