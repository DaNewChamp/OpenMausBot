import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./ApprovalCard";
import type { Message } from "@/state/store";

describe("ApprovalCard plain language presentation", () => {
  it("renders plain-language headline, change summary badge, and expandable raw details", () => {
    const message: Message = {
      id: "m-1",
      role: "bot",
      at: Date.now(),
      kind: "options",
      text: "Needs approval",
      card: {
        title: "Scout needs your approval",
        subtitle: "git status",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "terminal",
        toolLabel: "Terminal",
        hostLabel: "Mac mini",
        actionSummary: "Run git status on Mac mini",
        details: "git status",
        executiveSummary: "Inspects repository status",
        changeSummary: "Nothing; read-only",
        riskLevel: "low",
        allowKey: "bridge:run_on_bridge:git",
      } as any,
    };

    const html = renderToStaticMarkup(
      <ApprovalCard bot={{ id: "b-1", name: "Scout" } as any} message={message} />
    );

    expect(html).toContain("Scout wants to run git status on Mac mini");
    expect(html).toContain("Does not change anything · read-only");
    expect(html).toContain("Details");
    expect(html).toContain("Tool: terminal");
    expect(html).toContain("Command: git status");
    expect(html).toContain("Scope: Mac mini (bridge:run_on_bridge:git)");
  });
});
