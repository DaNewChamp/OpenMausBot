import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_VM_INVOKE_TOOLS,
  LOCAL_VM_INVOKE_TOOL_NAMES,
  LOCAL_VM_STARTING_MESSAGE,
  botOwnsLocalVm,
  decideLocalVmEnsure,
  ensureLocalVm,
  executeLocalVmInvokeTool,
  isLocalVmInvokeTool,
  localComputerMountIsHost,
  localVmSelfInvokePrompt,
  localVmTurnContract,
  sanitizeLocalVmInvokeText,
  type LocalVmEnsureStatus,
} from "./local-vm-invoke.ts";

const readyStatus = (): LocalVmEnsureStatus => ({
  ready: true,
  container: "running",
  image: true,
  daemonUp: true,
  runtime: "podman",
  create_supported: true,
});

const missingStatus = (): LocalVmEnsureStatus => ({
  ready: false,
  container: "missing",
  image: true,
  daemonUp: true,
  runtime: "podman",
  create_supported: true,
});

describe("Local VM self-invoke capability gate", () => {
  it("hides the prompt and tools when the bot does not own a Local VM", () => {
    for (const computer of [undefined, "off", "local", "cloud"] as const) {
      const contract = localVmTurnContract({
        computer,
        mountsComputerMcp: true,
        driverKind: "claude",
        vmReady: false,
      });
      expect(botOwnsLocalVm(computer)).toBe(false);
      expect(contract.prompt).toBe("");
      expect(contract.exposeTools).toBe(false);
      expect(contract.mount).toBeNull();
      expect(contract.error).toBeNull();
    }
  });

  it("exposes the stable prompt and tools when Local VM is selected, even if the VM is not ready", () => {
    const contract = localVmTurnContract({
      computer: "vm",
      mountsComputerMcp: true,
      driverKind: "claude",
      vmReady: false,
      mode: "per-bot",
    });
    expect(contract.error).toBeNull();
    expect(contract.exposeTools).toBe(true);
    expect(contract.mount).toBe("vm");
    expect(contract.allowHostFallback).toBe(false);
    expect(contract.prompt).toContain("YOUR computer, not the user's Mac");
    expect(contract.prompt).toContain("use the computer and browser tools immediately");
    expect(contract.prompt).toContain("Do not ask whether you should use them");
    expect(contract.prompt).toContain("retryable starting state");
    expect(contract.prompt).toContain("retry the exact same computer action");
    expect(contract.prompt).not.toContain("/Users/");
    expect(contract.prompt).not.toContain("vnc.html");
    expect(contract.prompt).not.toContain("6080");
    expect(LOCAL_VM_INVOKE_TOOL_NAMES).toEqual([
      "screenshot",
      "get_desktop_state",
      "click",
      "type_text",
      "press_key",
      "launch_app",
      "open_url",
    ]);
    expect(LOCAL_VM_INVOKE_TOOL_NAMES).not.toContain("computer_exec");
    expect(isLocalVmInvokeTool("computer_exec")).toBe(false);
  });

  it("exposes the exact same stable tool contract when the VM is already ready and never allows host fallback", () => {
    const cold = localVmTurnContract({
      computer: "vm",
      mountsComputerMcp: true,
      driverKind: "acp",
      vmReady: false,
    });
    const ready = localVmTurnContract({
      computer: "vm",
      mountsComputerMcp: true,
      driverKind: "acp",
      vmReady: true,
    });
    expect(cold.mount).toBe("vm");
    expect(ready.mount).toBe("vm");
    expect(cold.exposeTools).toBe(true);
    expect(ready.exposeTools).toBe(true);
    expect(cold.prompt).toBe(ready.prompt);
    expect(ready.allowHostFallback).toBe(false);
    expect(localComputerMountIsHost({ scope: "local-computer" })).toBe(true);
    expect(localComputerMountIsHost({})).toBe(false);
  });

  it("keeps an unsupported engine from exposing Local VM tools or falling back to the host", () => {
    const contract = localVmTurnContract({
      computer: "vm",
      mountsComputerMcp: false,
      driverKind: "grok",
      vmReady: false,
    });
    expect(contract.exposeTools).toBe(false);
    expect(contract.prompt).toBe("");
    expect(contract.allowHostFallback).toBe(false);
    expect(contract.error).toMatch(/cannot use the Local VM/);
  });
});

describe("Local VM self-invoke prompt", () => {
  it("distinguishes the bot's computer from the user's Mac in both modes and guides retries", () => {
    const perBot = localVmSelfInvokePrompt("per-bot");
    const shared = localVmSelfInvokePrompt("shared");
    expect(perBot).toContain("reserved for this bot");
    expect(shared).toContain("shared, isolated Linux computer");
    for (const prompt of [perBot, shared]) {
      expect(prompt).toContain("not the user's Mac");
      expect(prompt).toContain("never fall back to it");
      expect(prompt).toContain("/home/cua/workspace");
      expect(prompt).toContain("retryable starting state");
      expect(prompt).toContain("retry the exact same computer action");
      expect(prompt).not.toMatch(/open google/i);
    }
  });
});

describe("lazy Local VM ensure", () => {
  it("is a no-op when the VM is already ready", async () => {
    const create = vi.fn();
    const recreate = vi.fn();
    const result = await ensureLocalVm({
      status: readyStatus(),
      lifecycleBusy: false,
      imageBusy: false,
      modeChangeBusy: false,
      provisionBusy: false,
      leaseOwnedByThisTurn: true,
      existingCount: 1,
      maxInstances: 2,
      mode: "per-bot",
      targetExists: true,
      create,
      recreate,
    });
    expect(result).toEqual({ state: "ready" });
    expect(create).not.toHaveBeenCalled();
    expect(recreate).not.toHaveBeenCalled();
  });

  it("creates a missing VM on first use and returns a retryable starting state until the desktop is ready", async () => {
    const create = vi.fn(async () => missingStatus());
    const recreate = vi.fn();
    const result = await ensureLocalVm({
      status: missingStatus(),
      lifecycleBusy: false,
      imageBusy: false,
      modeChangeBusy: false,
      provisionBusy: false,
      leaseOwnedByThisTurn: true,
      existingCount: 0,
      maxInstances: 2,
      mode: "per-bot",
      targetExists: false,
      create,
      recreate,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(recreate).not.toHaveBeenCalled();
    expect(result).toEqual({ state: "starting", retryable: true, message: LOCAL_VM_STARTING_MESSAGE });
  });

  it("preserves lease, capacity, and busy gates instead of falling back to the host", () => {
    expect(
      decideLocalVmEnsure({
        status: missingStatus(),
        lifecycleBusy: false,
        imageBusy: false,
        modeChangeBusy: false,
        provisionBusy: false,
        leaseOwnedByThisTurn: false,
        existingCount: 0,
        maxInstances: 2,
        mode: "per-bot",
        targetExists: false,
      }).action,
    ).toBe("blocked");
    expect(
      decideLocalVmEnsure({
        status: missingStatus(),
        lifecycleBusy: false,
        imageBusy: false,
        modeChangeBusy: false,
        provisionBusy: false,
        leaseOwnedByThisTurn: true,
        existingCount: 2,
        maxInstances: 2,
        mode: "per-bot",
        targetExists: false,
      }),
    ).toMatchObject({ action: "blocked", message: expect.stringContaining("limit is 2") });
    expect(
      decideLocalVmEnsure({
        status: { ...missingStatus(), ready: false, container: "running" },
        lifecycleBusy: true,
        imageBusy: false,
        modeChangeBusy: false,
        provisionBusy: false,
        leaseOwnedByThisTurn: true,
        existingCount: 1,
        maxInstances: 2,
        mode: "per-bot",
        targetExists: true,
      }),
    ).toMatchObject({ action: "wait", message: LOCAL_VM_STARTING_MESSAGE });
    expect(
      decideLocalVmEnsure({
        status: missingStatus(),
        lifecycleBusy: false,
        imageBusy: true,
        modeChangeBusy: false,
        provisionBusy: false,
        leaseOwnedByThisTurn: true,
        existingCount: 0,
        maxInstances: 2,
        mode: "per-bot",
        targetExists: false,
      }),
    ).toMatchObject({ action: "wait", message: expect.stringContaining("retry the exact same") });
  });

  it("recreates a stopped desktop because this image cannot safely resume", () => {
    expect(
      decideLocalVmEnsure({
        status: { ...readyStatus(), ready: false, container: "stopped" },
        lifecycleBusy: false,
        imageBusy: false,
        modeChangeBusy: false,
        provisionBusy: false,
        leaseOwnedByThisTurn: true,
        existingCount: 1,
        maxInstances: 2,
        mode: "per-bot",
        targetExists: true,
      }).action,
    ).toBe("recreate");
  });
});

describe("Local VM invoke sanitization", () => {
  it("strips loopback, non-loopback private URLs, host.docker.internal, and viewer tokens", () => {
    const leaked =
      "viewer vnc.html#password=secret-vnc " +
      "loopback http://127.0.0.1:6080/ " +
      "ipv6 http://[::1]:8080/api " +
      "zero http://0.0.0.0:8000/app " +
      "private10 http://10.0.0.5:8080/internal " +
      "private172 http://172.17.0.2:5900/display " +
      "private192 http://192.168.1.100:3000/ " +
      "docker-host http://host.docker.internal:5000/ " +
      "bare host.docker.internal address " +
      "VNC_PW=hunter2 token=sk-ant-abcdefghijklmnopqrstuvwxyz";
    const clean = sanitizeLocalVmInvokeText(leaked);
    expect(clean).not.toContain("127.0.0.1");
    expect(clean).not.toContain("[::1]");
    expect(clean).not.toContain("0.0.0.0");
    expect(clean).not.toContain("10.0.0.5");
    expect(clean).not.toContain("172.17.0.2");
    expect(clean).not.toContain("192.168.1.100");
    expect(clean).not.toContain("host.docker.internal");
    expect(clean).not.toContain("vnc.html");
    expect(clean).not.toContain("secret-vnc");
    expect(clean).not.toContain("hunter2");
    expect(clean).not.toContain("sk-ant-");
    expect(clean).toContain("[redacted-local-url]");
    expect(clean).toContain("[redacted-host]");
    expect(clean).toContain("[redacted-viewer]");
    expect(clean).toContain("VNC_PW=[redacted]");
  });

  it("strips runtime socket paths and bare VNC port disclosures", () => {
    const leaked =
      "socket unix:///var/run/podman.sock error " +
      "user runtime /run/user/1000/custom-service " +
      "docker /var/run/docker.sock failed " +
      "tmp socket /tmp/cua.sock " +
      "VNC server listening on port 5900 and :5901, viewer on port: 6080 and :6081 " +
      "rfbport 5900 active";
    const clean = sanitizeLocalVmInvokeText(leaked);
    expect(clean).not.toContain("/var/run/podman.sock");
    expect(clean).not.toContain("/run/user/1000/custom-service");
    expect(clean).not.toContain("/var/run/docker.sock");
    expect(clean).not.toContain("/tmp/cua.sock");
    expect(clean).not.toContain("5900");
    expect(clean).not.toContain("5901");
    expect(clean).not.toContain("6080");
    expect(clean).not.toContain("6081");
    expect(clean).toContain("[redacted-socket]");
    expect(clean).toContain("[redacted-path]");
    expect(clean).toContain("[redacted-port]");
  });

  it("strips host filesystem paths while preserving durable container paths and normal user content", () => {
    const text =
      "Checked host /Users/vincent/secret.txt and C:\\Users\\vincent\\file.txt " +
      "and /private/var/folders/xx/temp and /home/alice/data. " +
      "Durable folder /home/cua/workspace/project/main.ts is safe. " +
      "Found 5900 search results for query at https://google.com/search?q=openmausbot with price $6080 on port 3000.";
    const clean = sanitizeLocalVmInvokeText(text);
    expect(clean).not.toContain("/Users/vincent");
    expect(clean).not.toContain("C:\\Users\\vincent");
    expect(clean).not.toContain("/private/var/folders");
    expect(clean).not.toContain("/home/alice");
    expect(clean).toContain("[redacted-path]");
    // Durable path inside container preserved
    expect(clean).toContain("/home/cua/workspace/project/main.ts");
    // Normal user content untouched
    expect(clean).toContain("https://google.com/search?q=openmausbot");
    expect(clean).toContain("5900 search results");
    expect(clean).toContain("$6080");
    expect(clean).toContain("port 3000");
  });
});

describe("Local VM execute coverage and contract drift prevention", () => {
  const ctx = (runner: any) => ({
    runtime: "podman" as const,
    containerName: "openmausbot-computer",
    runner,
  });

  it("executes screenshot with base64 data and handles empty capture", async () => {
    const happyRunner = vi.fn(async (_runtime: any, args: string[]) => {
      if (args.includes("base64")) return { stdout: "iVBORw0KGgoAAAANSUhEUg==" };
      return { stdout: "ok" };
    });
    const result = await executeLocalVmInvokeTool("screenshot", {}, ctx(happyRunner));
    expect(result.isError).toBe(false);
    expect(result.image).toBe("iVBORw0KGgoAAAANSUhEUg==");
    expect(result.text).toContain("Captured this bot's Local VM desktop");

    const emptyRunner = vi.fn(async (_runtime: any, args: string[]) => {
      if (args.includes("base64")) return { stdout: "" };
      return { stdout: "ok" };
    });
    const emptyResult = await executeLocalVmInvokeTool("screenshot", {}, ctx(emptyRunner));
    expect(emptyResult.isError).toBe(true);
    expect(emptyResult.text).toMatch(/screenshot was empty/);
  });

  it("executes get_desktop_state and returns sanitized state", async () => {
    const runner = vi.fn(async () => ({ stdout: "window 1 at /home/cua/workspace" }));
    const result = await executeLocalVmInvokeTool("get_desktop_state", {}, ctx(runner));
    expect(result.isError).toBe(false);
    expect(result.text).toContain("window 1 at /home/cua/workspace");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("executes click with validation for numeric coordinates and button/double options", async () => {
    const runner = vi.fn(async () => ({ stdout: "clicked" }));
    const bad = await executeLocalVmInvokeTool("click", { x: "abc", y: 100 }, ctx(runner));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("needs numeric x and y");
    expect(runner).not.toHaveBeenCalled();

    const good = await executeLocalVmInvokeTool("click", { x: 100.4, y: 200.6, button: "right", double: true }, ctx(runner));
    expect(good.isError).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    const execArgs = (runner.mock.calls as any)[0][1] as string[];
    const payloadIndex = execArgs.indexOf("click") + 1;
    const payload = JSON.parse(execArgs[payloadIndex]);
    expect(payload).toEqual({
      x: 100,
      y: 201,
      button: "right",
      double: true,
    });
  });

  it("executes type_text with non-empty string validation", async () => {
    const runner = vi.fn(async () => ({ stdout: "typed" }));
    const bad = await executeLocalVmInvokeTool("type_text", { text: "" }, ctx(runner));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("needs text");
    expect(runner).not.toHaveBeenCalled();

    const good = await executeLocalVmInvokeTool("type_text", { text: "hello world" }, ctx(runner));
    expect(good.isError).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    const execArgs = (runner.mock.calls as any)[0][1] as string[];
    const payloadIndex = execArgs.indexOf("type_text") + 1;
    const payload = JSON.parse(execArgs[payloadIndex]);
    expect(payload).toEqual({ text: "hello world" });
  });

  it("executes press_key with non-empty keys validation", async () => {
    const runner = vi.fn(async () => ({ stdout: "pressed" }));
    const bad = await executeLocalVmInvokeTool("press_key", { keys: "   " }, ctx(runner));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("needs keys");
    expect(runner).not.toHaveBeenCalled();

    const good = await executeLocalVmInvokeTool("press_key", { keys: "Return" }, ctx(runner));
    expect(good.isError).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    const execArgs = (runner.mock.calls as any)[0][1] as string[];
    const payloadIndex = execArgs.indexOf("press_key") + 1;
    const payload = JSON.parse(execArgs[payloadIndex]);
    expect(payload).toEqual({ keys: "Return" });
  });

  it("executes launch_app with non-empty app name validation", async () => {
    const runner = vi.fn(async () => ({ stdout: "launched" }));
    const bad = await executeLocalVmInvokeTool("launch_app", { app: "" }, ctx(runner));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("needs an app name");
    expect(runner).not.toHaveBeenCalled();

    const good = await executeLocalVmInvokeTool("launch_app", { app: "gedit" }, ctx(runner));
    expect(good.isError).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
    const execArgs = (runner.mock.calls as any)[0][1] as string[];
    const payloadIndex = execArgs.indexOf("launch_app") + 1;
    const payload = JSON.parse(execArgs[payloadIndex]);
    expect(payload).toEqual({ app: "gedit" });
  });

  it("executes open_url only for valid http(s) URLs and rejects arbitrary protocols", async () => {
    const runner = vi.fn(async () => ({ stdout: "launched" }));
    const badFile = await executeLocalVmInvokeTool("open_url", { url: "file:///etc/passwd" }, ctx(runner));
    expect(badFile.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();

    const badJs = await executeLocalVmInvokeTool("open_url", { url: "javascript:alert(1)" }, ctx(runner));
    expect(badJs.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();

    const good = await executeLocalVmInvokeTool("open_url", { url: "https://example.com/test" }, ctx(runner));
    expect(good.isError).toBe(false);
    expect(good.text).toContain("example.com");
    expect(runner).toHaveBeenCalledTimes(1);
    const execArgs = (runner.mock.calls as any)[0][1] as string[];
    const payloadIndex = execArgs.indexOf("launch_app") + 1;
    const payload = JSON.parse(execArgs[payloadIndex]);
    expect(payload).toEqual({
      app: "google-chrome",
      arguments: ["https://example.com/test"],
    });
  });

  it("catches and sanitizes command runner exceptions", async () => {
    const failingRunner = vi.fn(async () => {
      throw new Error("fatal: socket /tmp/cua.sock refused on port 5900 with user path /run/user/1000/app");
    });
    const result = await executeLocalVmInvokeTool("get_desktop_state", {}, ctx(failingRunner));
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("/tmp/cua.sock");
    expect(result.text).not.toContain("5900");
    expect(result.text).not.toContain("/run/user/1000/app");
    expect(result.text).toContain("[redacted-socket]");
    expect(result.text).toContain("[redacted-path]");
    expect(result.text).toContain("[redacted-port]");
  });

  it("enforces exact contract alignment between advertised tools and executor", async () => {
    const runner = vi.fn(async () => ({ stdout: "ok" }));
    const advertised = LOCAL_VM_INVOKE_TOOLS.map((t) => t.name);
    expect(advertised).toEqual(LOCAL_VM_INVOKE_TOOL_NAMES);

    // Every advertised tool must be recognized by isLocalVmInvokeTool
    for (const name of advertised) {
      expect(isLocalVmInvokeTool(name)).toBe(true);
    }

    // Every advertised tool must be handled by executeLocalVmInvokeTool
    const sampleArgs: Record<string, object> = {
      screenshot: {},
      get_desktop_state: {},
      click: { x: 10, y: 10 },
      type_text: { text: "hello" },
      press_key: { keys: "Tab" },
      launch_app: { app: "xterm" },
      open_url: { url: "https://google.com" },
    };

    for (const name of advertised) {
      const args = sampleArgs[name] ?? {};
      const res = await executeLocalVmInvokeTool(name, args, ctx(runner));
      expect(res.text).not.toContain("not available on this bot's Local VM");
    }

    // Any unadvertised tool must be rejected by isLocalVmInvokeTool and executeLocalVmInvokeTool
    const unadvertised = ["computer_exec", "bash", "write_file", "eval", "terminal"];
    for (const name of unadvertised) {
      expect(isLocalVmInvokeTool(name)).toBe(false);
      const res = await executeLocalVmInvokeTool(name, {}, ctx(runner));
      expect(res.isError).toBe(true);
      expect(res.text).toContain("That computer tool is not available on this bot's Local VM");
    }
  });
});
