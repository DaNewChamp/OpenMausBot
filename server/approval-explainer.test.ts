import { describe, expect, it, vi } from "vitest";

import { approvalGrantSummary, explainApproval, isReadOnlyShellCommand, reviewApproval } from "./approval-explainer.ts";
import { approvalKey } from "./auto-approve.ts";
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
    expect(presentation.reason).toBe(
      "This request needs your approval because the bot wants to inspect recent Git history, configured remotes, and the latest files for the OpenMausBot repository on Mac mini. Nothing runs unless you approve.",
    );
    expect(presentation.alwaysAllowSummary).toBeUndefined();
  });

  it("uses a concrete executive summary for a mutating command and scopes a standing grant", () => {
    const explanation = explainApproval("terminal", "git push origin main", "Mac mini");
    expect(explanation.executiveSummary).toBe("Publishes local commits to a remote repository");
    expect(approvalPresentation("terminal", "git push origin main", "local-computer").reason).toBe(
      "This request needs your approval because the bot wants to publish local commits to a remote repository on Mac mini. Nothing runs unless you approve.",
    );

    const presentation = approvalPresentation("terminal", "git status --short", "bridge");
    expect(presentation.alwaysAllowSummary).toBe("Always allow Terminal to run git commands on Bridge.");
    expect(approvalPresentation("terminal", "rm -rf /tmp/scratch", "bridge").alwaysAllowSummary).toBeUndefined();
  });

  it("uses the same effective program as the grant key through env and sudo wrappers", () => {
    const command = "env NODE_ENV=test sudo apt-get install ripgrep";
    expect(approvalKey("Bash", command)).toBe("Bash:apt-get");
    expect(approvalGrantSummary("Terminal", command, "Mac mini")).toBe(
      "Always allow Terminal to run apt-get commands on Mac mini.",
    );
  });

  it("does not offer a misleading standing grant for broad non-command tools", () => {
    const presentation = approvalPresentation("Read", "server/config.ts", undefined);
    expect(presentation.alwaysAllowSummary).toBeUndefined();
    expect(approvalGrantSummary("Read", "server/config.ts", "Mac mini")).toBeUndefined();
  });

  it("uses deterministic sensitive and network facts in the approval reason", () => {
    expect(approvalPresentation("terminal", "cat ~/.ssh/id_ed25519", "local-computer").reason).toBe(
      "This request needs your approval because the bot wants to read information that may contain credentials or private data on Mac mini. Nothing runs unless you approve.",
    );
    expect(approvalPresentation("terminal", "curl https://example.com", "local-computer").reason).toBe(
      "This request needs your approval because the bot wants to connect to another computer or online service on Mac mini. Nothing runs unless you approve.",
    );
    expect(approvalPresentation("terminal", "rm -rf /tmp/build", "local-computer").reason).toBe(
      "This request needs your approval because the bot wants to delete files or folders on Mac mini. Nothing runs unless you approve.",
    );
  });

  function expectFailClosed(command: string) {
    expect(isReadOnlyShellCommand("terminal", command), command).toBe(false);
    const explanation = explainApproval("terminal", command, "Mac mini");
    expect(explanation.riskLevel, command).not.toBe("low");
    const presentation = approvalPresentation("terminal", command, "local-computer");
    expect(presentation.riskLevel, command).not.toBe("low");
    expect(presentation.actionSummary, command).not.toContain("read-only");
    expect(presentation.changeSummary === "Nothing; read-only" && presentation.riskLevel !== "low").toBe(false);
  }

  function expectReadOnly(command: string) {
    expect(isReadOnlyShellCommand("terminal", command), command).toBe(true);
    const explanation = explainApproval("terminal", command, "Mac mini");
    expect(explanation.riskLevel, command).toBe("low");
    expect(explanation.changeSummary, command).toBe("Nothing; read-only");
    const presentation = approvalPresentation("terminal", command, "local-computer");
    expect(presentation.actionSummary, command).toBe("Run a read-only command on Mac mini");
    expect(presentation.riskLevel, command).toBe("low");
  }

  it.each([
    "cat <(ls)",
    "cat <(echo hello)",
    "sort <(head README.md)",
    "grep foo <(cat README.md)",
    "echo hello >(cat)",
  ])("fails closed for process substitution %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "ls\nunknown-bin --pwn",
    "git status\nunknown-bin --pwn",
    "ls & unknown-bin --pwn",
    "git status & unknown-bin --pwn",
    "ls || unknown-bin --pwn",
    "git status || git remote add origin https://example.com/x.git",
  ])("fails closed across shell boundary in %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "git remote",
    "git remote -v",
    "git remote --verbose",
    "git remote get-url origin",
    "git remote show origin",
  ])("treats git remote read form %s as read-only", (command) => {
    expectReadOnly(command);
  });

  it.each([
    "git remote add origin https://example.com/x.git",
    "git remote remove origin",
    "git remote rm origin",
    "git remote rename origin upstream",
    "git remote set-url origin https://example.com/x.git",
    "git remote set-head origin main",
    "git remote update",
    "git remote prune origin",
  ])("fails closed for git remote mutation %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch --list",
    "git branch --show-current",
  ])("treats git branch read form %s as read-only", (command) => {
    expectReadOnly(command);
  });

  it.each([
    "git branch feature/pwn",
    "git branch -d old",
    "git branch -D old",
    "git branch --delete old",
    "git branch -m old new",
    "git branch -M old new",
    "git branch --move old new",
    "git branch -c old new",
    "git branch -C old new",
    "git branch --copy old new",
  ])("fails closed for git branch mutation %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "find . -delete",
    "find . -exec cat {} ;",
    "find . -execdir cat {} ;",
    "find . -ok true {} ;",
    "find . -okdir true {} ;",
    "find . -fprint /tmp/out",
    "find . -fprintf /tmp/out %p",
    "find . -fls /tmp/out",
    "find . -fprint0 /tmp/out",
  ])("fails closed for find mutating flag in %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "sed -n 'e ls'",
    "sed -n 'w /tmp/out'",
    "sed -n 'W /tmp/out'",
    "sed -n 's/foo/bar/e'",
    "sed -e 's/x/y/w /tmp/out' -n",
    "sed -i '' 's/old/new/' README.md",
    "sed --in-place 's/old/new/' README.md",
    "sed -f mutate.sed README.md",
  ])("fails closed for sed write or execute %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "sudo ls",
    "sudo git status",
    "sudo sed -n '1,180p' STAFF.md",
    "sudo cat README.md",
  ])("fails closed for sudo elevation in %s", (command) => {
    expectFailClosed(command);
  });

  it.each([
    "git status; unknown-bin --pwn",
    "git status && unknown-bin --pwn",
    "git status | unknown-bin --pwn",
    "cd /tmp; python3 -c 'print(1)'",
    "true || python3 -c 'print(1)'",
  ])("fails closed for unknown program after control boundary %s", (command) => {
    expectFailClosed(command);
  });

  it("keeps summaries sanitized and never lets actionSummary disagree with risk", () => {
    const explanation = explainApproval("terminal", "cd OpenMausBot && ls && head \u001b[31mREADME.md", "Mac mini");
    expect(explanation.executiveSummary).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(explanation.changeSummary).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(explanation.resourceSummary).not.toMatch(/[\u0000-\u001f\u007f]/);
    const presentation = approvalPresentation("terminal", "find . -delete", "local-computer");
    expect(presentation.riskLevel).not.toBe("low");
    expect(presentation.actionSummary).not.toContain("read-only");
    const processSub = explainApproval("terminal", "cat <(curl https://evil.test/secret)\u0007", "Mac mini");
    expect(processSub.executiveSummary).not.toMatch(/<\(|\u0007|evil\.test/);
    expect(processSub.resourceSummary).not.toMatch(/<\(|\u0007/);
  });

  it.each([
    "echo ok > result.txt",
    "git push origin main",
    "unknown-tool --do-it",
    "curl https://example.com",
    "cat $(whoami).txt",
    "ls | xargs rm",
  ])("keeps mutating or ambiguous command %s fail-closed", (command) => {
    expectFailClosed(command);
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
