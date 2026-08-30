import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEGACY_BUNDLE_ID,
  LEGACY_PRODUCT_NAME,
  LEGACY_PROTOCOL,
  PRODUCT_NAME,
  PRODUCT_PROTOCOL,
  resolveCompatibleUserDataPath,
} from "./product-identity.mjs";

describe("V Bot desktop identity", () => {
  it("keeps the public name separate from legacy install identifiers", () => {
    assert.equal(PRODUCT_NAME, "V Bot");
    assert.equal(PRODUCT_PROTOCOL, "vbot");
    assert.equal(LEGACY_PRODUCT_NAME, "OpenMausBot");
    assert.equal(LEGACY_PROTOCOL, "openmausbot");
    assert.equal(LEGACY_BUNDLE_ID, "com.openmausbot.app");
  });

  it("uses legacy state in place when an existing installation is found", () => {
    const current = "/Users/ada/Library/Application Support/V Bot";
    assert.equal(
      resolveCompatibleUserDataPath({
        currentPath: current,
        appDataPath: "/Users/ada/Library/Application Support",
        exists: (candidate) => candidate.endsWith("/OpenMausBot"),
      }),
      "/Users/ada/Library/Application Support/OpenMausBot",
    );
  });

  it("does not invent or overwrite state when no legacy directory exists", () => {
    const current = "/Users/ada/Library/Application Support/V Bot";
    assert.equal(
      resolveCompatibleUserDataPath({
        currentPath: current,
        appDataPath: "/Users/ada/Library/Application Support",
        exists: () => false,
      }),
      current,
    );
  });
});
