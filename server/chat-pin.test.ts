import { describe, expect, it } from "vitest";

import { parseChatPin } from "./chat-pin.ts";

describe("parseChatPin", () => {
  it("accepts exactly a Boolean pinned value", () => {
    expect(parseChatPin({ pinned: true })).toEqual({ ok: true, pinned: true });
    expect(parseChatPin({ pinned: false })).toEqual({ ok: true, pinned: false });
  });

  it("rejects missing, wrong-type, and extra fields", () => {
    expect(parseChatPin({}).ok).toBe(false);
    expect(parseChatPin({ pinned: "true" }).ok).toBe(false);
    expect(parseChatPin({ pinned: true, autoApprove: true }).ok).toBe(false);
    expect(parseChatPin(null).ok).toBe(false);
  });
});
