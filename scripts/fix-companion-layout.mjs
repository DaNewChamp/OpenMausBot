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
const tsconfig = JSON.parse(
  readFileSync(join(root, "tsconfig.companion.build.json"), "utf8"),
);

function expectedSubdirJs(subdir) {
  const names = new Set();
  for (const pattern of tsconfig.include ?? []) {
    if (!pattern.startsWith(`${subdir}/`) || !pattern.endsWith(".ts")) continue;
    names.add(`${pattern.slice(subdir.length + 1, -3)}.js`);
  }
  return names;
}

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
const expectedServer = expectedSubdirJs("server");
const expectedShared = expectedSubdirJs("shared");

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
expectedShared.add("hub-identity.mjs");

for (const name of listDir(sharedDir)) {
  if (expectedShared.has(name)) continue;
  rmSync(join(sharedDir, name));
}

for (const name of listDir(serverDir)) {
  if (expectedServer.has(name)) continue;
  rmSync(join(serverDir, name));
}

rmSync(join(out, "companion"), { recursive: true, force: true });

const entry = join(out, "index.js");
if (!existsSync(entry)) {
  console.error(`companion entry missing: ${entry}`);
  process.exit(1);
}

console.log(`companion layout ready: ${entry}`);
