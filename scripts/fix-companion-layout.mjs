import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-companion");
const nested = join(out, "companion", "src");
const serverDir = join(out, "server");
const sharedDir = join(out, "shared");

function rewriteCompanionImports(source) {
  return source
    .replaceAll("../../server/", "./server/")
    .replaceAll("../../shared/", "./shared/");
}

function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

if (!existsSync(nested)) {
  console.error(`companion build output missing: ${nested}`);
  process.exit(1);
}

const companionJs = listDir(nested).filter((name) => name.endsWith(".js"));
const expectedRoot = new Set(companionJs);
const expectedServer = new Set(listDir(serverDir));
const expectedShared = new Set(listDir(sharedDir).filter((name) => name.endsWith(".js")));

for (const name of listDir(out)) {
  const path = join(out, name);
  if (!statSync(path).isFile() || !name.endsWith(".js") || expectedRoot.has(name)) continue;
  rmSync(path);
}

for (const name of companionJs) {
  const from = join(nested, name);
  const to = join(out, name);
  writeFileSync(to, rewriteCompanionImports(readFileSync(from, "utf8")));
}

mkdirSync(sharedDir, { recursive: true });
cpSync(join(root, "shared", "hub-identity.mjs"), join(sharedDir, "hub-identity.mjs"));

for (const name of listDir(sharedDir)) {
  if (name === "hub-identity.mjs" || vendoredSharedJs.has(name)) continue;
  rmSync(join(sharedDir, name));
}

for (const name of listDir(serverDir)) {
  if (vendoredServerJs.has(name)) continue;
  rmSync(join(serverDir, name));
}

rmSync(join(out, "companion"), { recursive: true, force: true });

const entry = join(out, "index.js");
if (!existsSync(entry)) {
  console.error(`companion entry missing: ${entry}`);
  process.exit(1);
}

console.log(`companion layout ready: ${entry}`);
