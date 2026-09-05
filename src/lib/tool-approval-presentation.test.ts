import { describe, expect, it } from "vitest";
import {
  toolApprovalPresentation,
  type OptionCardLike,
} from "./tool-approval-presentation";

describe("ToolApprovalPresentationPolicy", () => {
  it("formats read-only git status card with plain-language headline and details", () => {
    const card: OptionCardLike = {
      title: "Scout needs your approval",
      subtitle: "git status",
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
    };

    const pres = toolApprovalPresentation("Scout", card);
    expect(pres.headline).toBe("Scout wants to run git status on Mac mini");
    expect(pres.changeDescription).toBe("Does not change anything · read-only");
    expect(pres.isReadOnly).toBe(true);
    expect(pres.rawTool).toBe("terminal");
    expect(pres.rawCommand).toBe("git status");
    expect(pres.scope).toBe("Mac mini (bridge:run_on_bridge:git)");
    expect(pres.detailsText).toContain("Tool: terminal");
    expect(pres.detailsText).toContain("Command: git status");
    expect(pres.detailsText).toContain("Scope: Mac mini (bridge:run_on_bridge:git)");
  });

  it("formats destructive command card clearly communicating state changes", () => {
    const card: OptionCardLike = {
      title: "Worker needs your approval",
      subtitle: "rm -rf ./build",
      requestId: "req-2",
      tool: "terminal",
      toolLabel: "Terminal",
      hostLabel: "Mac mini",
      actionSummary: "Run a command on Mac mini",
      details: "rm -rf ./build",
      executiveSummary: "Deletes files or folders",
      changeSummary: "Deletes files or folders",
      riskLevel: "high",
    };

    const pres = toolApprovalPresentation("Worker", card);
    expect(pres.headline).toBe("Worker wants to run rm -rf ./build on Mac mini");
    expect(pres.changeDescription).toBe("Changes files or system state · Deletes files or folders");
    expect(pres.isReadOnly).toBe(false);
    expect(pres.rawTool).toBe("terminal");
    expect(pres.rawCommand).toBe("rm -rf ./build");
    expect(pres.scope).toBe("Mac mini");
  });

  it("formats computer tool card with human-readable action and host", () => {
    const card: OptionCardLike = {
      title: "Bot needs your approval",
      subtitle: "Click submit button",
      requestId: "req-5",
      tool: "mcp__ogb__computer_batch",
      toolLabel: "Computer",
      hostLabel: "Mac mini",
      actionSummary: "Use the computer on Mac mini",
      details: "Click submit button",
      executiveSummary: "Clicks the submit button",
      changeSummary: "May interact with an app or the desktop",
      riskLevel: "medium",
    };

    const pres = toolApprovalPresentation("Bot", card);
    expect(pres.headline).toBe("Bot wants to use the computer on Mac mini");
    expect(pres.changeDescription).toBe("Changes files or system state · May interact with an app or the desktop");
    expect(pres.isReadOnly).toBe(false);
    expect(pres.scope).toBe("Mac mini");
  });

  it("extracts actor from title when actor is not provided explicitly", () => {
    const card: OptionCardLike = {
      title: "Scout needs your approval",
      subtitle: "git diff",
      tool: "terminal",
      hostLabel: "Mac mini",
    };

    const pres = toolApprovalPresentation("", card);
    expect(pres.headline).toContain("Scout wants to");
  });
});
