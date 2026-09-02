import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bridge");
const nested = join(out, "bridge", "src");
const sharedDir = join(out, "shared");
const tsconfig = JSON.parse(
  readFileSync(join(root, "tsconfig.bridge.build.json"), "utf8"),
);

function expectedSubdirJs(subdir) {
  const names = new Set();
  for (const pattern of tsconfig.include ?? []) {
    if (!pattern.startsWith(`${subdir}/`) || !pattern.endsWith(".ts")) continue;
    names.add(`${pattern.slice(subdir.length + 1, -3)}.js`);
  }
  return names;
}

function rewriteBridgeImports(source) {
  return source
    .replaceAll("../../server/", "./server/")
    .replaceAll("../../shared/", "./shared/");
}

function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

if (!existsSync(nested)) {
  console.error(`bridge build output missing: ${nested}`);
  process.exit(1);
}

const bridgeJs = listDir(nested).filter((name) => name.endsWith(".js"));
const expectedRoot = new Set(bridgeJs);
const expectedShared = expectedSubdirJs("shared");

for (const name of listDir(out)) {
  const path = join(out, name);
  if (!statSync(path).isFile() || !name.endsWith(".js") || expectedRoot.has(name)) continue;
  rmSync(path);
}

for (const name of bridgeJs) {
  const from = join(nested, name);
  const to = join(out, name);
  writeFileSync(to, rewriteBridgeImports(readFileSync(from, "utf8")));
}

for (const name of listDir(sharedDir)) {
  if (expectedShared.has(name)) continue;
  rmSync(join(sharedDir, name));
}

rmSync(join(out, "bridge"), { recursive: true, force: true });

const entry = join(out, "index.js");
if (!existsSync(entry)) {
  console.error(`bridge entry missing: ${entry}`);
  process.exit(1);
}

console.log(`bridge layout ready: ${entry}`);
