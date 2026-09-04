import { describe, expect, it, vi } from "vitest";
import { emitAuthorizedFrame } from "./web-client-stream";

describe("emitAuthorizedFrame", () => {
  it("passes through an object already parsed by createSseParser", () => {
    const onFrame = vi.fn();
    emitAuthorizedFrame(onFrame, { kind: "hello", resumed: false });
    expect(onFrame).toHaveBeenCalledWith({ kind: "hello", resumed: false });
  });

  it("parses a string payload", () => {
    const onFrame = vi.fn();
    emitAuthorizedFrame(onFrame, '{"kind":"message"}');
    expect(onFrame).toHaveBeenCalledWith({ kind: "message" });
  });

  it("does not throw when JSON.parse would fail on an object", () => {
    const onFrame = vi.fn();
    expect(() => emitAuthorizedFrame(onFrame, { kind: "hello" })).not.toThrow();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });
});
