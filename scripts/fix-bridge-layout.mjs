import { build } from "esbuild";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bridge");
const nested = join(out, "bridge", "src");
const serverDir = join(out, "server");
const sharedDir = join(out, "shared");

function collectRelativeImports(source) {
  const imports = [];
  const pattern = /(?:from|import)\s+["'](\.\.?\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    imports.push(match[1]);
  }
  return imports;
}

function resolveJsImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base) && statSync(base).isFile()) return base;
  if (existsSync(`${base}.js`)) return `${base}.js`;
  if (existsSync(join(base, "index.js"))) return join(base, "index.js");
  return null;
}

function runtimeRelativeJs(entry) {
  const queue = [entry];
  const visited = new Set();
  const rootJs = new Set();
  const serverJs = new Set();
  const sharedJs = new Set();

  while (queue.length > 0) {
    const abs = queue.pop();
    if (visited.has(abs)) continue;
    visited.add(abs);

    const rel = relative(out, abs);
    if (!rel.includes("/") && rel.endsWith(".js")) {
      rootJs.add(rel);
    } else if (rel.startsWith("server/") && rel.endsWith(".js")) {
      serverJs.add(rel.slice("server/".length));
    } else if (rel.startsWith("shared/") && rel.endsWith(".js")) {
      sharedJs.add(rel.slice("shared/".length));
    }

    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");
    for (const specifier of collectRelativeImports(source)) {
      const resolved = resolveJsImport(abs, specifier);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }

  return { rootJs, serverJs, sharedJs };
}

function rewriteBridgeImports(source) {
  return source
    .replaceAll("../../server/", "./server/")
    .replaceAll("../../shared/", "./shared/")
    .replaceAll(/from ["']yaml["']/g, 'from "./yaml.js"')
    .replaceAll(/import ["']yaml["']/g, 'import "./yaml.js"');
}

async function vendorYaml() {
  const yamlBrowser = join(root, "node_modules", "yaml", "browser", "index.js");
  if (!existsSync(yamlBrowser)) {
    console.error("yaml dependency missing");
    process.exit(1);
  }
  await build({
    entryPoints: [yamlBrowser],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile: join(out, "yaml.js"),
    logLevel: "silent",
  });
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
for (const name of bridgeJs) {
  const from = join(nested, name);
  const to = join(out, name);
  writeFileSync(to, rewriteBridgeImports(readFileSync(from, "utf8")));
}

const entry = join(out, "index.js");
if (!existsSync(entry)) {
  console.error(`bridge entry missing: ${entry}`);
  process.exit(1);
}

await vendorYaml();

const runtime = runtimeRelativeJs(entry);

for (const name of listDir(out)) {
  const path = join(out, name);
  if (!statSync(path).isFile() || !name.endsWith(".js") || runtime.rootJs.has(name)) continue;
  rmSync(path);
}

for (const name of listDir(sharedDir)) {
  if (runtime.sharedJs.has(name)) continue;
  rmSync(join(sharedDir, name));
}

pruneServerDir(serverDir, runtime.serverJs);

rmSync(join(out, "bridge"), { recursive: true, force: true });

console.log(`bridge layout ready: ${entry}`);
