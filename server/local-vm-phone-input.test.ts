import { describe, expect, it, vi } from "vitest";

import type { CommandRunner, Runtime } from "./container-computer.ts";
import {
  executeLocalVmPhoneInput,
  validateLocalVmPhoneInput,
} from "./local-vm-phone-input.ts";

const runtime: Runtime = "docker";
const containerName = "openmausbot-computer-bot-1";

describe("Local VM phone input validation", () => {
  it("accepts click, scroll, type, and key actions only", () => {
    expect(validateLocalVmPhoneInput({ action: "click", x: 10, y: 20 })).toMatchObject({
      input: { action: "click", x: 10, y: 20 },
    });
    expect(validateLocalVmPhoneInput({ action: "scroll", direction: "up", clicks: 2 })).toMatchObject({
      input: { action: "scroll", direction: "up", clicks: 2 },
    });
    expect(validateLocalVmPhoneInput({ action: "type", text: "hello" })).toMatchObject({
      input: { action: "type", text: "hello" },
    });
    expect(validateLocalVmPhoneInput({ action: "key", keys: "Return" })).toMatchObject({
      input: { action: "key", keys: "Return" },
    });
    expect(validateLocalVmPhoneInput({ action: "exec", command: "id" })).toEqual({
      error: "action must be click, scroll, type, or key",
    });
  });
});

describe("Local VM phone input execution", () => {
  it("routes click and scroll through Chromium DevTools", async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "ok" });
    const click = await executeLocalVmPhoneInput(
      { action: "click", x: 4, y: 8, button: "right" },
      { runtime, containerName, runner },
    );
    expect(click.isError).toBe(false);
    expect(runner.mock.calls[0]?.[1]?.join(" ")).toContain("mouse");

    runner.mockClear();
    const scroll = await executeLocalVmPhoneInput(
      { action: "scroll", direction: "down", clicks: 5, x: 1, y: 2 },
      { runtime, containerName, runner },
    );
    expect(scroll.isError).toBe(false);
    expect(runner.mock.calls[0]?.[1]?.join(" ")).toContain("scroll");
  });
});
