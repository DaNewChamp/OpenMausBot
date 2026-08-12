// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to OpenMausBot and the
//    driver inherits them. One prompt, named OpenMausBot, out of the box.
//  - "standalone" (dev): attach to an already-installed CuaDriver.app daemon
//    (its own TCC identity, typically already granted on a dev machine).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const HOST_BUNDLE_ID = "com.openmausbot.app";
const IS_WIN = process.platform === "win32";

// Driver locations outside the app bundle. macOS ships CuaDriver.app; on
// Windows the trycua Cua app installs under %LOCALAPPDATA%\Programs, and
// cua-driver.exe may also be on PATH.
const STANDALONE_SOCKET = path.join(
  app.getPath("home"),
  "Library/Caches/cua-driver/cua-driver.sock",
);
const INSTALLED_DRIVER_CANDIDATES = IS_WIN
  ? [
      path.join(
        process.env.LOCALAPPDATA ?? path.join(app.getPath("home"), "AppData", "Local"),
        "Programs",
        "Cua",
        "cua-driver",
        "bin",
        "cua-driver.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA ?? path.join(app.getPath("home"), "AppData", "Local"),
        "Programs",
        "CuaDriver",
        "cua-driver.exe",
      ),
      path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "CuaDriver", "cua-driver.exe"),
    ]
  : ["/Applications/CuaDriver.app/Contents/MacOS/cua-driver"];

function driverOnPath() {
  const find = IS_WIN ? "where" : "which";
  try {
    const out = spawnSync(find, ["cua-driver"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (out.status === 0 && out.stdout) return out.stdout.split(/\r?\n/)[0].trim();
  } catch {
    /* no PATH lookup available */
  }
  return null;
}

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let connection = null; // descriptor exposed to harness + renderer

export function resolveDriverBinary() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cua-driver");
    if (fs.existsSync(bundled)) return bundled;
  }
  for (const candidate of INSTALLED_DRIVER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return driverOnPath();
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

async function startEmbedded(binary) {
  // Dynamic import: the SDK ships a native FFI lib; keep dev startup
  // resilient if it fails to load on this machine.
  const { EmbeddedCuaDriverHost } = await import("@trycua/cua-driver/embedded");
  embeddedHost = new EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  const conn = await embeddedHost.start();
  return {
    mode: "embedded",
    socketPath: conn.socketPath,
    mcpCommand: binary,
    mcpArgs: ["mcp", "--embedded", "--socket", conn.socketPath],
    mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID },
  };
}

async function daemonRunning() {
  // On Windows the daemon listens on a named pipe that a unix-style socket
  // connect can't probe; `cua-driver status` reports liveness cross-platform.
  if (IS_WIN) {
    const binary = resolveDriverBinary();
    if (!binary) return false;
    // async child — never block the main process on a dead daemon
    return new Promise((resolveProbe) => {
      let out = "";
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveProbe(ok);
      };
      let child;
      try {
        child = spawn(binary, ["status"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return done(false);
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        done(false);
      }, 5000);
      child.stdout.on("data", (d) => (out += d));
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0 && /daemon is running/i.test(out)));
    });
  }
  return socketAlive(STANDALONE_SOCKET);
}

export async function startCua() {
  const binary = resolveDriverBinary();
  if (!binary) {
    connection = { mode: "unavailable", reason: "cua-driver binary not found" };
    return connection;
  }

  const wantEmbedded =
    app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1";

  if (wantEmbedded) {
    try {
      connection = await startEmbedded(binary);
    } catch (err) {
      connection = {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  } else if (await daemonRunning()) {
    // Dev machine with a cua-driver daemon already running (CuaDriver.app on
    // macOS, the trycua Cua app / `cua-driver serve` on Windows). The MCP
    // proxy discovers the daemon itself, so no socket path is needed.
    connection = {
      mode: "standalone",
      ...(IS_WIN ? {} : { socketPath: STANDALONE_SOCKET }),
      mcpCommand: binary,
      mcpArgs: ["mcp"],
      mcpEnv: {},
    };
  } else {
    connection = {
      mode: "unavailable",
      reason:
        "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
    };
  }

  fs.writeFileSync(
    path.join(app.getPath("userData"), "cua-connection.json"),
    JSON.stringify(connection, null, 2),
  );
  return connection;
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (embeddedHost) {
    try {
      await embeddedHost.stop();
      embeddedHost.uniffiDestroy?.();
    } catch {
      // daemon holds a parent-liveness pipe; host death closes it anyway
    }
    embeddedHost = null;
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connection);
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
}
