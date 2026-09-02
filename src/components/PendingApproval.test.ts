import { describe, expect, it } from "vitest";

import { pendingApprovals } from "./PendingApproval";
import type { Message } from "@/state/store";

describe("pending approval presentation data", () => {
  it("keeps the plain reason and narrow standing-grant explanation", () => {
    const message: Message = {
      id: "approval-1",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Allow Terminal on Mac mini?",
        subtitle: "git status --short",
        options: ["Allow", "Deny", "Always allow"],
        requestId: "request-1",
        tool: "Bash",
        allowKey: "Bash:git",
        reason: "This request needs your approval because it will inspect repository status on Mac mini.",
        alwaysAllowSummary: "Always allow Terminal to run git commands on Mac mini.",
        details: "git status --short && git diff --stat",
      },
    };

    expect(pendingApprovals([message])[0]).toMatchObject({
      detail: "git status --short && git diff --stat",
      reason: "This request needs your approval because it will inspect repository status on Mac mini.",
      alwaysAllowSummary: "Always allow Terminal to run git commands on Mac mini.",
    });
  });

  it("drops a standing-grant explanation when the card has no narrow key", () => {
    const message: Message = {
      id: "approval-broad",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Allow file read?",
        subtitle: "server/config.ts",
        options: ["Allow", "Deny", "Always allow"],
        requestId: "request-broad",
        tool: "Read",
        alwaysAllowSummary: "Always allow Read for this exact action on the workspace.",
      },
    };

    expect(pendingApprovals([message])[0]?.alwaysAllowSummary).toBeUndefined();
  });
});
