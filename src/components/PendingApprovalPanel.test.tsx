import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingApprovalPanel, type Pending } from "./PendingApproval";
import type { Message } from "@/state/store";

describe("PendingApprovalPanel plain language presentation", () => {
  it("renders plain-language headline and expandable raw details in composer takeover", () => {
    const message: Message = {
      id: "m-1",
      role: "bot",
      at: Date.now(),
      kind: "options",
      text: "Needs approval",
      card: {
        title: "Atlas needs your approval",
        subtitle: "git diff HEAD~1",
        options: ["Allow", "Deny"],
        requestId: "req-atlas-1",
        tool: "terminal",
        toolLabel: "Terminal",
        hostLabel: "Studio Mac",
        actionSummary: "Run git diff HEAD~1 on Studio Mac",
        details: "git diff HEAD~1",
        executiveSummary: "Inspects previous commit changes",
        changeSummary: "Nothing; read-only",
        riskLevel: "low",
        allowKey: "bridge:run_on_bridge:git_diff",
      } as any,
    };

    const pending: Pending = {
      message,
      requestId: "req-atlas-1",
      tool: "terminal",
      allowKey: "bridge:run_on_bridge:git_diff",
      detail: "git diff HEAD~1",
      reason: "Inspect diff",
      executiveSummary: "Inspects previous commit changes",
      changeSummary: "Nothing; read-only",
      riskLevel: "low",
    };

    const html = renderToStaticMarkup(
      <PendingApprovalPanel
        pending={pending}
        count={1}
        index={0}
        bot={{ id: "b-atlas", name: "Atlas" } as any}
      />
    );

    expect(html).toContain("Atlas wants to run git diff HEAD~1 on Studio Mac");
    expect(html).toContain("Does not change anything · read-only");
    expect(html).toContain("Details");
    expect(html).toContain("Tool: terminal");
    expect(html).toContain("Command: git diff HEAD~1");
    expect(html).toContain("Scope: Studio Mac (bridge:run_on_bridge:git_diff)");
  });
});
