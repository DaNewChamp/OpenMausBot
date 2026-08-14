// Which transport a bot's computer uses. This is the one decision that
// separates "drive a cloud box over REST" from "drive a container on this
// machine over exec", and both drivers depend on getting it right.
import { describe, expect, it } from "vitest";

import { CONTAINER, IMAGE, computerProxyEnv, setupCommands } from "./container-computer.ts";

describe("computerProxyEnv", () => {
  it("hands the proxy a container when the bot runs on a local VM", () => {
    expect(computerProxyEnv({ kind: "container", container: "openmausbot-computer", runtime: "podman" })).toEqual({
      OGB_CONTAINER: "openmausbot-computer",
      OGB_RUNTIME: "podman",
    });
  });

  it("defaults the runtime rather than shipping an empty command", () => {
    expect(computerProxyEnv({ kind: "container", container: "c" }).OGB_RUNTIME).toBe("docker");
  });

  it("hands the proxy a box otherwise — the cloud path is unchanged", () => {
    expect(computerProxyEnv({ boxId: "bx_1", token: "t" })).toEqual({
      OGB_BOX_ID: "bx_1",
      OGB_BOX_TOKEN: "t",
    });
  });

  it("never leaks box credentials into a container turn", () => {
    const env = computerProxyEnv({ kind: "container", container: "c", runtime: "docker" });
    expect(env.OGB_BOX_TOKEN).toBeUndefined();
    expect(env.OGB_BOX_ID).toBeUndefined();
  });
});

describe("setupCommands", () => {
  it("uses the runtime the user actually has", () => {
    expect(setupCommands("podman").pull).toBe(`podman pull ${IMAGE}`);
    expect(setupCommands("podman").run).toContain("podman run -d --name");
  });

  it("falls back to docker when nothing is installed, so the steps still read", () => {
    expect(setupCommands(null).pull.startsWith("docker pull ")).toBe(true);
  });

  it("names one container, so start/stop/remove all refer to the same thing", () => {
    const c = setupCommands("docker");
    for (const cmd of [c.run, c.start, c.stop, c.remove]) expect(cmd).toContain(CONTAINER);
  });

  it("publishes the desktop so a human can watch what the bot does", () => {
    expect(setupCommands("docker").run).toContain("-p 6080:6080");
    expect(setupCommands("docker").view).toContain("6080");
  });
});
