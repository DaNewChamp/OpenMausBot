// Environment-neutral runtime vocabulary shared by Node/Electron and Worker
// code. Keep the arrays ordered: order is part of the parity contract.
export const RUNTIME_PROFILES = Object.freeze([
  "desktop-hub",
  "headless-hub",
  "desktop-client",
]);

export const WIRE_PLATFORMS = Object.freeze(["darwin", "windows", "linux"]);
