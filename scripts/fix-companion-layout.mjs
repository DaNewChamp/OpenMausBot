import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-companion");
const nested = join(out, "companion", "src");

function rewriteCompanionImports(source) {
  return source
    .replaceAll("../../server/", "./server/")
    .replaceAll("../../shared/", "./shared/");
}

if (!existsSync(nested)) {
  console.error(`companion build output missing: ${nested}`);
  process.exit(1);
}

for (const name of readdirSync(nested)) {
  if (!name.endsWith(".js")) continue;
  const from = join(nested, name);
  const to = join(out, name);
  writeFileSync(to, rewriteCompanionImports(readFileSync(from, "utf8")));
}

mkdirSync(join(out, "shared"), { recursive: true });
cpSync(join(root, "shared", "hub-identity.mjs"), join(out, "shared", "hub-identity.mjs"));

rmSync(join(out, "companion"), { recursive: true, force: true });

const entry = join(out, "index.js");
if (!existsSync(entry)) {
  console.error(`companion entry missing: ${entry}`);
  process.exit(1);
}

console.log(`companion layout ready: ${entry}`);
