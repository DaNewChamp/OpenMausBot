"use strict";

const fs = require("node:fs");
const path = require("node:path");

function browserConnectionDescriptor(connection) {
  if (connection === null) return null;
  if (!connection || connection.version !== 1 || !/^[0-9a-f]{64}$/.test(String(connection.token ?? ""))) {
    throw new Error("the browser connection descriptor is invalid");
  }
  const raw = String(connection.url ?? "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the browser connection descriptor URL is invalid");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("the browser connection descriptor URL must be a loopback origin");
  }
  if (!Number.isInteger(connection.pid) || connection.pid <= 0) throw new Error("the browser connection descriptor PID is invalid");
  return { version: 1, url: url.origin, token: String(connection.token), pid: connection.pid };
}

/** Packaged builds transport the browser master token over Electron's
 * private utility-process port. Remove any descriptor left by an older build
 * before the child starts so it cannot become a same-user shell bypass. */
function removeBrowserConnectionDescriptor({ userData, fileSystem = fs }) {
  const descriptorPath = path.join(userData, "browser-connection.json");
  try {
    fileSystem.unlinkSync(descriptorPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function postBrowserConnection(proc, connection) {
  if (!proc || typeof proc.postMessage !== "function") throw new Error("the browser connection parent port is unavailable");
  proc.postMessage({ type: "openmausbot:browser-connection", connection: browserConnectionDescriptor(connection ?? null) });
}

module.exports = { browserConnectionDescriptor, postBrowserConnection, removeBrowserConnectionDescriptor };
