import { describe, expect, it } from "vitest";

import {
  BROWSER_CDP_HELPER,
  BROWSER_VM_IMAGE,
  BROWSER_VM_LAYER_VERSION,
  browserCdpExecArgs,
  browserVmDockerfile,
  browserVmImageLabelsMatch,
} from "./browser-vm-image.ts";

describe("browser VM image", () => {
  it("is a localhost-tagged lightweight Chromium image", () => {
    expect(BROWSER_VM_IMAGE).toBe("localhost/openmausbot/browser-vm:v1");
    expect(BROWSER_VM_LAYER_VERSION).toBe("1");
  });

  it("pins Node 22 tarball checksums and ships Chromium, git, and the CDP helper", () => {
    const dockerfile = browserVmDockerfile();
    expect(dockerfile).toContain("FROM debian:bookworm-slim");
    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("git");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain("69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec");
    expect(dockerfile).toContain("08bfbf538bad0e8cbb0269f0173cca28d705874a67a22f60b57d99dc99e30050");
    expect(dockerfile).toContain("--headless=new");
    expect(dockerfile).toContain("--remote-debugging-port=9222");
    expect(dockerfile).toContain(BROWSER_CDP_HELPER);
    expect(dockerfile).not.toContain("trycua");
    expect(dockerfile).not.toContain("cua-driver");
    expect(dockerfile).not.toContain("xfce");
  });

  it("matches only browser-kind image labels", () => {
    expect(
      browserVmImageLabelsMatch({
        "com.openmausbot.local-vm": "1",
        "com.openmausbot.computer-kind": "browser",
        "com.openmausbot.image-layer": "1",
      }),
    ).toBe(true);
    expect(
      browserVmImageLabelsMatch({
        "com.openmausbot.local-vm": "1",
        "com.openmausbot.cua-driver": "0.20.0",
        "com.openmausbot.image-layer": "5",
      }),
    ).toBe(false);
  });

  it("execs the CDP helper as cua", () => {
    expect(browserCdpExecArgs("screenshot", {}, { container: "openmausbot-computer" })).toEqual([
      "exec",
      "-u",
      "cua",
      "-e",
      "HOME=/home/cua",
      "openmausbot-computer",
      "node",
      BROWSER_CDP_HELPER,
      "screenshot",
      "e30",
    ]);
  });
});
