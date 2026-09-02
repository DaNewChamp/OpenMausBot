import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "dist-bridge",
  "dist-companion",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "electron/resources/speech-helper",
  "electron/resources/OpenMausBot Speech.app",
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
