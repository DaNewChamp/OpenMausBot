import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

describe("V Bot private desktop release contract", () => {
  it("uses V Bot artifact names while keeping legacy package identity", () => {
    const builder = read("electron-builder.yml");
    assert.match(builder, /^appId:\s*com\.openmausbot\.app\s*$/m);
    assert.match(builder, /^productName:\s*V Bot\s*$/m);
    assert.match(builder, /^artifactName:\s*VBot-/m);
    assert.match(builder, /schemes:\s*\[vbot, openmausbot\]/);
  });

  it("does not leave legacy artifact globs or public updater assertions", () => {
    for (const workflow of [".github/workflows/release.yml", ".github/workflows/package-linux.yml", ".github/workflows/package-win.yml"]) {
      const text = read(workflow);
      assert.doesNotMatch(text, /release\/OpenMausBot-/);
      assert.doesNotMatch(text, /app-update\.yml[^\n]*openmausbot-releases/i);
      assert.doesNotMatch(text, /grep[^\n]*openmausbot-releases[^\n]*app-update/i);
    }
  });

  it("accepts only explicit generic private metadata", () => {
    const script = read("scripts/verify-vbot-update-metadata.mjs");
    assert.match(script, /provider:\\s\*generic/);
    assert.match(script, /protocol !== \"https:\"/);
    assert.match(script, /github\\.com/);
    assert.ok(existsSync(new URL("scripts/verify-vbot-update-metadata.mjs", root)));
  });
});
