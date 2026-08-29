#!/usr/bin/env node
// First-class hub export/import. Companion data is included by default.
//
//   node scripts/hub-archive.mjs export --dest /tmp/hub-export --host-profile servarica
//   node scripts/hub-archive.mjs import --archive /tmp/hub-export --host-profile servarica
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { applyHostProfile, exportHubArchive, importHubArchive, loadHostProfile } from "../server/hub-archive.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0];
const opt = (name) => args.find((a, i) => args[i - 1] === `--${name}`);
const flags = new Set(args.filter((a) => a.startsWith("--")));

const profileId = opt("host-profile");
const profilesPath = join(root, "scripts", "host-profiles.json");
const profile = profileId ? loadHostProfile(profilesPath, profileId) : null;
const dataDir = opt("data-dir") ?? profile?.dataDir ?? process.env.OMB_USER_DATA ?? join(homedir(), ".openmausbot");
const companionDir = flags.has("--no-companion")
  ? undefined
  : (opt("companion-dir") ?? profile?.companionDir ?? join(homedir(), ".openmausbot-companion"));

if (command === "export") {
  const dest = opt("dest");
  if (!dest) throw new Error("usage: hub-archive export --dest <dir> [--host-profile servarica]");
  const manifest = exportHubArchive({
    dataDir,
    destDir: dest,
    companionDir,
    sourceHost: profileId,
  });
  if (profile) applyHostProfile(dest, profile);
  console.log(JSON.stringify(manifest, null, 2));
} else if (command === "import") {
  const archive = opt("archive");
  if (!archive) throw new Error("usage: hub-archive import --archive <dir> [--host-profile servarica]");
  const manifest = importHubArchive({
    archiveDir: archive,
    dataDir,
    companionDir,
    profile: profile ?? undefined,
  });
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(`hub-archive

  export --dest <dir> [--host-profile servarica|mac-mini] [--data-dir PATH] [--no-companion]
  import --archive <dir> [--host-profile servarica|mac-mini] [--data-dir PATH] [--no-companion]
`);
}
