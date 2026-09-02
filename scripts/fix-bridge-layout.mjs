import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bridge");
const nested = join(out, "bridge", "src");
const serverDir = join(out, "server");
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

function expandIncludes() {
  const files = new Set();
  for (const pattern of tsconfig.include ?? []) {
    if (pattern.includes("*")) {
      for (const match of globSync(pattern, { cwd: root })) {
        if (match.endsWith(".ts")) files.add(match);
      }
      continue;
    }
    if (pattern.endsWith(".ts")) files.add(pattern);
  }

  const excluded = new Set();
  for (const pattern of tsconfig.exclude ?? []) {
    if (pattern.includes("*")) {
      for (const match of globSync(pattern, { cwd: root })) excluded.add(match);
      continue;
    }
    excluded.add(pattern);
  }

  return [...files].filter((file) => !excluded.has(file));
}

function collectRelativeImports(source) {
  const imports = [];
  const pattern = /(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    imports.push(match[1]);
  }
  return imports;
}

function resolveTsImport(fromFile, specifier) {
  const base = join(dirname(fromFile), specifier);
  if (existsSync(base) && statSync(base).isFile()) return base;
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(join(base, "index.ts"))) return join(base, "index.ts");
  return null;
}

function expectedEmittedServerJs() {
  const queue = expandIncludes();
  const visited = new Set();
  const serverJs = new Set();

  while (queue.length > 0) {
    const rel = queue.pop();
    if (visited.has(rel)) continue;
    visited.add(rel);

    if (rel.startsWith("server/") && rel.endsWith(".ts")) {
      serverJs.add(`${rel.slice("server/".length, -3)}.js`);
    }

    const abs = join(root, rel);
    if (!existsSync(abs)) continue;

    const source = readFileSync(abs, "utf8");
    for (const specifier of collectRelativeImports(source)) {
      const resolved = resolveTsImport(abs, specifier);
      if (!resolved) continue;
      const resolvedRel = relative(root, resolved);
      if (!visited.has(resolvedRel)) queue.push(resolvedRel);
    }
  }

  return serverJs;
}

function rewriteBridgeImports(source) {
  return source
    .replaceAll("../../server/", "./server/")
    .replaceAll("../../shared/", "./shared/");
}

function listDir(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function pruneServerDir(dir, expected, relativePrefix = "") {
  if (!existsSync(dir)) return;

  for (const name of listDir(dir)) {
    const rel = relativePrefix ? `${relativePrefix}/${name}` : name;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      pruneServerDir(path, expected, rel);
      if (existsSync(path) && listDir(path).length === 0) {
        rmSync(path, { recursive: true, force: true });
      }
      continue;
    }
    if (!name.endsWith(".js") || expected.has(rel)) continue;
    rmSync(path);
  }
}

if (!existsSync(nested)) {
  console.error(`bridge build output missing: ${nested}`);
  process.exit(1);
}

const bridgeJs = listDir(nested).filter((name) => name.endsWith(".js"));
const expectedRoot = new Set(bridgeJs);
const expectedShared = expectedSubdirJs("shared");
const expectedServer = expectedEmittedServerJs();

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

pruneServerDir(serverDir, expectedServer);

rmSync(join(out, "bridge"), { recursive: true, force: true });

const entry = join(out, "index.js");
if (!existsSync(entry)) {
  console.error(`bridge entry missing: ${entry}`);
  process.exit(1);
}

console.log(`bridge layout ready: ${entry}`);
