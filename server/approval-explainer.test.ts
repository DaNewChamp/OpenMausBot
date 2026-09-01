import { describe, expect, it, vi } from "vitest";

import { explainApproval, isReadOnlyShellCommand, reviewApproval } from "./approval-explainer.ts";
import { approvalPresentation } from "./index.ts";

describe("approval explanations", () => {
  it("treats OpenMausBot git inspection as read-only with a concrete multi-action summary", () => {
    const command =
      "cd ~/Github/OpenMausBot 2>/dev/null && git log -5 --oneline --date=short --format='%h %ad %s' 2>/dev/null; echo '---'; git remote -v 2>/dev/null | head -2; echo '---'; ls -lt ~/Github/OpenMausBot 2>/dev/null | head -5";
    expect(isReadOnlyShellCommand("terminal", command)).toBe(true);
    const explanation = explainApproval("terminal", command, "Mac mini");
    expect(explanation).toMatchObject({
      executiveSummary: "Inspects recent Git history, configured remotes, and the latest files for the OpenMausBot repository",
      changeSummary: "Nothing; read-only",
      resourceSummary: "OpenMausBot repository on Mac mini",
      riskLevel: "low",
      confidence: "high",
      source: "local",
    });
    const presentation = approvalPresentation("terminal", command, "local-computer");
    expect(presentation.actionSummary).toBe("Run a read-only command on Mac mini");
    expect(presentation.riskLevel).toBe("low");
    expect(presentation.changeSummary).toBe("Nothing; read-only");
  });

  it.each([
    "echo ok > result.txt",
    "git push origin main",
    "unknown-tool --do-it",
    "curl https://example.com",
    "cat $(whoami).txt",
    "ls | xargs rm",
  ])("keeps mutating or ambiguous command %s fail-closed", (command) => {
    expect(isReadOnlyShellCommand("terminal", command)).toBe(false);
    expect(explainApproval("terminal", command, "Mac mini").riskLevel).not.toBe("low");
  });

  it("summarizes the staff and routing read without echoing shell noise", () => {
    const explanation = explainApproval(
      "run_on_bridge",
      "printf '%s\\n' '=== STAFF ==='; sed -n '1,180p' STAFF.md; printf '%s\\n' '=== ROUTING ==='; sed -n '1,180p' OPEN-GROK-ROUTING-RUNBOOK.md",
      "Mac mini",
    );
    expect(explanation).toMatchObject({
      executiveSummary: "Reads STAFF.md and OPEN-GROK-ROUTING-RUNBOOK.md",
      changeSummary: "Nothing; read-only",
      resourceSummary: "STAFF.md and OPEN-GROK-ROUTING-RUNBOOK.md on Mac mini",
      riskLevel: "low",
      confidence: "high",
      source: "local",
    });
  });

  it.each([
    ["cat README.md", "low"],
    ["git status --short", "low"],
    ["rg -n TODO server", "low"],
    ["find . -maxdepth 2 -type f", "low"],
  ])("treats %s as read-only", (command, risk) => {
    expect(explainApproval("terminal", command, "Mac mini").riskLevel).toBe(risk);
    expect(explainApproval("terminal", command, "Mac mini").changeSummary).toBe("Nothing; read-only");
  });

  it.each([
    "rm -rf build",
    "sed -i '' 's/old/new/' README.md",
    "git push origin main",
    "echo ok > result.txt",
  ])("marks mutating command %s as high risk", (command) => {
    const explanation = explainApproval("terminal", command, "Mac mini");
    expect(explanation.riskLevel).toBe("high");
    expect(explanation.changeSummary).toContain("May");
  });

  it("marks credential reads as sensitive", () => {
    const explanation = explainApproval("terminal", "cat ~/.ssh/id_ed25519", "Mac mini");
    expect(explanation.riskLevel).toBe("high");
    expect(explanation.executiveSummary).toContain("credentials");
  });

  it("fails closed for ambiguous tools", () => {
    const explanation = explainApproval("mystery_tool", "do something complicated", "Mac mini");
    expect(explanation.riskLevel).toBe("high");
    expect(explanation.changeSummary).toContain("could not be fully determined");
    expect(explanation.confidence).toBe("low");
  });

  it("keeps the optional reviewer bounded and never lowers local risk", async () => {
    const reviewer = vi.fn(async () => ({
      purpose: "Reviews a deployment file",
      change: "Nothing; read-only",
      where: "DEPLOY.md on Mac mini",
      risk: "low",
    }));
    const explanation = await reviewApproval("terminal", "cat .env", "Mac mini", reviewer);
    expect(reviewer).toHaveBeenCalledOnce();
    expect(explanation.source).toBe("ai-reviewed");
    expect(explanation.riskLevel).toBe("high");
  });

  it("falls back when reviewer output is invalid or times out", async () => {
    const invalid = await reviewApproval("terminal", "cat README.md", "Mac mini", async () => ({ nope: true }));
    expect(invalid.source).toBe("local");
    const timeout = await reviewApproval("terminal", "cat README.md", "Mac mini", async (_input, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return {};
    }, 100);
    expect(timeout.source).toBe("local");
  });
});
