import { describe, expect, it, vi } from "vitest";

import {
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

  it("exposes the prompt and tools when Local VM is selected, even if the VM is not ready", () => {
    const contract = localVmTurnContract({
      computer: "vm",
      mountsComputerMcp: true,
      driverKind: "claude",
      vmReady: false,
      mode: "per-bot",
    });
    expect(contract.error).toBeNull();
    expect(contract.exposeTools).toBe(true);
    expect(contract.mount).toBe("lazy");
    expect(contract.allowHostFallback).toBe(false);
    expect(contract.prompt).toContain("YOUR computer, not the user's Mac");
    expect(contract.prompt).toContain("use the computer and browser tools immediately");
    expect(contract.prompt).toContain("Do not ask whether you should use them");
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

  it("mounts official Cua tools when the VM is already ready and never allows host fallback", () => {
    const contract = localVmTurnContract({
      computer: "vm",
      mountsComputerMcp: true,
      driverKind: "acp",
      vmReady: true,
    });
    expect(contract.mount).toBe("cua");
    expect(contract.exposeTools).toBe(true);
    expect(contract.allowHostFallback).toBe(false);
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
  it("distinguishes the bot's computer from the user's Mac in both modes", () => {
    const perBot = localVmSelfInvokePrompt("per-bot");
    const shared = localVmSelfInvokePrompt("shared");
    expect(perBot).toContain("reserved for this bot");
    expect(shared).toContain("shared, isolated Linux computer");
    for (const prompt of [perBot, shared]) {
      expect(prompt).toContain("not the user's Mac");
      expect(prompt).toContain("never fall back to it");
      expect(prompt).toContain("/home/cua/workspace");
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

describe("Local VM invoke sanitization and tool bounds", () => {
  it("strips host paths, VNC URLs, ports, and secrets from tool output", () => {
    const leaked =
      "viewer http://127.0.0.1:6080/vnc.html#password=secret-vnc VNC_PW=hunter2 path /Users/vincent/.openmausbot/vm-home token=sk-ant-abcdefghijklmnopqrstuvwxyz";
    const clean = sanitizeLocalVmInvokeText(leaked);
    expect(clean).not.toContain("127.0.0.1");
    expect(clean).not.toContain("6080");
    expect(clean).not.toContain("vnc.html");
    expect(clean).not.toContain("secret-vnc");
    expect(clean).not.toContain("hunter2");
    expect(clean).not.toContain("/Users/vincent");
    expect(clean).not.toContain("sk-ant-");
    expect(clean).toContain("[redacted-local-url]");
    expect(clean).toContain("[redacted-path]");
  });

  it("refuses arbitrary host terminal tools", async () => {
    const runner = vi.fn();
    const denied = await executeLocalVmInvokeTool("computer_exec", { command: "id" }, {
      runtime: "podman",
      containerName: "openmausbot-computer",
      runner,
    });
    expect(denied.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("opens only http(s) URLs through Cua launch_app inside the VM", async () => {
    const runner = vi.fn(async () => ({ stdout: "ok" }));
    const bad = await executeLocalVmInvokeTool("open_url", { url: "file:///etc/passwd" }, {
      runtime: "podman",
      containerName: "openmausbot-computer",
      runner,
    });
    expect(bad.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();

    const opened = await executeLocalVmInvokeTool("open_url", { url: "https://google.com" }, {
      runtime: "podman",
      containerName: "openmausbot-computer",
      runner,
    });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("google.com");
    expect(runner).toHaveBeenCalledTimes(1);
    const spawned = JSON.stringify(runner.mock.calls);
    expect(spawned).toContain("call");
    expect(spawned).toContain("launch_app");
    expect(spawned).toContain("https://google.com");
    expect(spawned).not.toContain("computer_exec");
  });
});
