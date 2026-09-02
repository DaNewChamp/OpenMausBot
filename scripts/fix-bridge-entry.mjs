import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-bridge");
const entry = join(out, "bridge", "src", "index.js");
const shim = join(out, "index.js");

if (!existsSync(entry)) {
  console.error(`bridge entry missing: ${entry}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
copyFileSync(entry, shim);
console.log(`bridge entry shim: ${shim}`);
