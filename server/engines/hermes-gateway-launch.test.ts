import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";

import { createHermesBotEngine, type HermesProcess, type HermesSpawn } from "./hermes.ts";
import {
  HERMES_GATEWAY_MODULE,
  resolveHermesGatewayLaunch,
} from "./hermes-gateway-launch.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function makeFakeHermesTree(options: {
  platform?: NodeJS.Platform;
  layout?: "unix-venv" | "win-venv" | "flat";
  symlinkCli?: boolean;
} = {}): {
  sourceRoot: string;
  cliPath: string;
  pythonPath: string;
} {
  const platform = options.platform ?? process.platform;
  const root = mkdtempSync(join(tmpdir(), "vbot-hermes-launch-"));
  roots.push(root);
  const sourceRoot = join(root, "hermes-agent");
  mkdirSync(join(sourceRoot, "tui_gateway"), { recursive: true });
  writeFileSync(join(sourceRoot, "tui_gateway", "entry.py"), "# fixture marker\n");

  let cliPath = "";
  let pythonPath = "";

  if (options.layout === "win-venv" || (options.layout === undefined && platform === "win32")) {
    const scripts = join(sourceRoot, "venv", "Scripts");
    mkdirSync(scripts, { recursive: true });
    pythonPath = join(scripts, "python.exe");
    cliPath = join(scripts, "hermes.exe");
    writeFileSync(pythonPath, "");
    writeFileSync(cliPath, "");
  } else if (options.layout === "flat") {
    cliPath = join(sourceRoot, "hermes");
    pythonPath = join(sourceRoot, "python3");
    writeFileSync(cliPath, "#!/usr/bin/env python3\n");
    writeFileSync(pythonPath, "");
  } else {
    const bin = join(sourceRoot, "venv", "bin");
    mkdirSync(bin, { recursive: true });
    pythonPath = join(bin, "python3");
    cliPath = join(bin, "hermes");
    writeFileSync(pythonPath, "");
    writeFileSync(cliPath, `#!${pythonPath}\n`);
  }

  if (options.symlinkCli) {
    const linked = join(root, "linked-bin", "hermes");
    mkdirSync(dirname(linked), { recursive: true });
    symlinkSync(cliPath, linked);
    cliPath = linked;
  }

  return { sourceRoot, cliPath, pythonPath };
}

describe("resolveHermesGatewayLaunch", () => {
  it("prefers explicit HERMES_PYTHON_SRC_ROOT and HERMES_PYTHON overrides", () => {
    const launch = resolveHermesGatewayLaunch({
      cli: "/missing/hermes",
      cwd: "/work",
      environment: {
        HERMES_PYTHON_SRC_ROOT: "/opt/hermes-src",
        HERMES_PYTHON: "/opt/hermes-venv/bin/python3",
        HERMES_CWD: "/ignored",
        PYTHONPATH: "/existing",
      },
    }, {
      exists: (path) => path === "/opt/hermes-src/tui_gateway/entry.py",
      realpath: (path) => path,
      readFile: () => "",
    });

    expect(launch).toEqual({
      command: "/opt/hermes-venv/bin/python3",
      args: ["-m", HERMES_GATEWAY_MODULE],
      cwd: "/work",
      env: expect.objectContaining({
        HERMES_PYTHON: "/opt/hermes-venv/bin/python3",
        HERMES_PYTHON_SRC_ROOT: "/opt/hermes-src",
        PYTHONPATH: `/opt/hermes-src${process.platform === "win32" ? ";" : ":"}/existing`,
      }),
    });
  });

  it("derives unix venv layout and shebang python from the resolved Hermes CLI", () => {
    const tree = makeFakeHermesTree({ layout: "unix-venv" });
    const launch = resolveHermesGatewayLaunch({
      cli: tree.cliPath,
      environment: { PATH: dirname(tree.cliPath) },
    });

    expect(launch).toMatchObject({
      command: tree.pythonPath,
      args: ["-m", HERMES_GATEWAY_MODULE],
      env: expect.objectContaining({
        PYTHONPATH: expect.stringContaining("hermes-agent"),
      }),
    });
    if (!("error" in launch)) {
      expect(launch.cwd).toContain("hermes-agent");
    }
  });

  it("derives Windows Scripts layout without shell interpolation", () => {
    const tree = makeFakeHermesTree({ platform: "win32", layout: "win-venv" });
    const launch = resolveHermesGatewayLaunch({
      cli: tree.cliPath,
      environment: {},
    }, { platform: "win32" });

    if (!("error" in launch)) {
      expect(launch.command).toContain("python.exe");
      expect(launch.cwd).toContain("hermes-agent");
    }
  });

  it("follows symlinked Hermes CLI paths when resolving the source root", () => {
    const tree = makeFakeHermesTree({ layout: "unix-venv", symlinkCli: true });
    const launch = resolveHermesGatewayLaunch({
      cli: tree.cliPath,
      environment: {},
    });

    if (!("error" in launch)) {
      expect(launch.command).toContain("python3");
      expect(launch.cwd).toContain("hermes-agent");
    }
  });

  it("returns missing_cli when the gateway entry module is absent", () => {
    const launch = resolveHermesGatewayLaunch({
      cli: "/opt/hermes/bin/hermes",
      environment: { HERMES_PYTHON_SRC_ROOT: "/opt/hermes-src" },
    }, {
      exists: () => false,
      realpath: (path) => path,
      readFile: () => "",
    });

    expect(launch).toEqual({ error: "missing_cli" });
  });
});

describe("Hermes gateway compatibility fixture", () => {
  it("launches the injectable fake root with the python gateway command contract", async () => {
    const home = mkdtempSync(join(tmpdir(), "vbot-hermes-compat-"));
    roots.push(home);
    const sourceRoot = join(home, "fake-src");
    const gatewayDir = join(sourceRoot, "tui_gateway");
    mkdirSync(gatewayDir, { recursive: true });
    writeFileSync(join(gatewayDir, "entry.py"), "# marker\n");

    const fixtureSource = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-hermes-tui-gateway.ts");
    const launcher = join(home, "gateway-launcher.cjs");
    writeFileSync(launcher, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fixture = ${JSON.stringify(fixtureSource)};
const args = process.argv.slice(2);
if (!(args[0] === "-m" && args[1] === "tui_gateway.entry")) process.exit(2);
const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
process.stdin.on("data", (chunk) => child.stdin.write(chunk));
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`, { mode: 0o700 });

    const child: HermesProcess = new EventEmitter();
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { writable: true, write: () => true },
      kill: () => true,
    });
    const spawn = vi.fn<HermesSpawn>(() => child);
    const engine = createHermesBotEngine({
      cli: join(home, "bin", "hermes"),
      environment: {
        HERMES_PYTHON_SRC_ROOT: sourceRoot,
        HERMES_PYTHON: launcher,
        HERMES_HOME: join(home, "hermes-home"),
      },
      spawn,
      timeouts: { initializationMs: 500, requestMs: 500, turnMs: 500, reconnectMs: 500 },
    });

    await expect(engine.discover()).resolves.toMatchObject({ state: "unavailable" });
    expect(spawn).toHaveBeenCalledWith(
      launcher,
      ["-m", "tui_gateway.entry"],
      expect.objectContaining({
        cwd: sourceRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: expect.objectContaining({
          HERMES_PYTHON: launcher,
          HERMES_PYTHON_SRC_ROOT: sourceRoot,
          PYTHONPATH: sourceRoot,
        }),
      }),
    );
    await engine.close();
  });
});
