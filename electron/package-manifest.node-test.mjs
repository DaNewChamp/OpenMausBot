import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

describe("V Bot packaged runtime manifest", () => {
  it("ships every shared module required by the Electron entrypoint", () => {
    const builder = parse(read("electron-builder.yml"));
    assert.ok(Array.isArray(builder.files));
    assert.ok(builder.files.includes("electron/**"));
    assert.ok(builder.files.includes("shared/control-plane-client.mjs"));
    assert.ok(builder.files.includes("shared/hub-identity.mjs"));
    assert.ok(builder.files.includes("shared/runtime-vocabulary.mjs"));

    const entrypoint = read("electron/control-plane-client.mjs");
    assert.match(entrypoint, /\.\.\/shared\/control-plane-client\.mjs/);
    assert.match(read("electron/main.mjs"), /\.\.\/shared\/hub-identity\.mjs/);
    assert.match(read("shared/control-plane-client.mjs"), /\.\/runtime-vocabulary\.mjs/);
  });

  it("keeps the package metadata compatible with the shared MJS runtime", () => {
    const packageJSON = JSON.parse(read("package.json"));
    assert.equal(packageJSON.type, "module");
    assert.equal(packageJSON.main, "electron/main.mjs");
    assert.equal(parse(read("electron-builder.yml")).asar, true);
  });
});
