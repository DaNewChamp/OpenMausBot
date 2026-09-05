export interface OptionCardLike {
  title?: string;
  subtitle?: string;
  requestId?: string;
  tool?: string;
  toolLabel?: string;
  hostLabel?: string;
  actionSummary?: string;
  details?: string;
  executiveSummary?: string;
  changeSummary?: string;
  resourceSummary?: string;
  riskLevel?: string;
  allowKey?: string;
}

export interface ToolApprovalPresentation {
  headline: string;
  changeDescription: string;
  isReadOnly: boolean;
  rawTool: string;
  rawCommand: string;
  scope: string;
  detailsText: string;
}

function sanitizeText(raw?: string): string {
  if (!raw) return "";
  return raw.trim();
}

function isCommandLineTool(card: OptionCardLike): boolean {
  if (card.toolLabel && card.toolLabel.toLowerCase() === "terminal") return true;
  if (card.tool) {
    const t = card.tool.toLowerCase();
    return (
      t.includes("terminal") ||
      t.includes("bash") ||
      t.includes("shell") ||
      t.includes("bridge") ||
      t.includes("ssh")
    );
  }
  return false;
}

function extractActorFromTitle(title?: string): string | null {
  if (!title) return null;
  const sanitized = sanitizeText(title);
  const matchNeeds = sanitized.match(/^(.*?)\s+needs your approval/i);
  if (matchNeeds && matchNeeds[1].trim()) return matchNeeds[1].trim();
  const matchWants = sanitized.match(/^(.*?)\s+wants to/i);
  if (matchWants && matchWants[1].trim()) return matchWants[1].trim();
  return null;
}

export function isApprovalReadOnly(card: OptionCardLike): boolean {
  if (card.changeSummary) {
    const cs = card.changeSummary.trim().toLowerCase();
    if (cs === "nothing; read-only" || cs === "read-only") return true;
    if (
      cs.includes("delete") ||
      cs.includes("modify") ||
      cs.includes("create") ||
      cs.includes("change")
    ) {
      return false;
    }
  }
  if (card.actionSummary && card.actionSummary.toLowerCase().includes("read-only")) {
    return true;
  }
  if (card.riskLevel) {
    const r = card.riskLevel.toLowerCase();
    if (r === "high" || r === "medium") return false;
  }
  const cmd = sanitizeText(card.details || card.subtitle).toLowerCase();
  if (
    cmd.startsWith("git status") ||
    cmd.startsWith("git log") ||
    cmd.startsWith("git diff") ||
    cmd.startsWith("git show") ||
    cmd.startsWith("git branch") ||
    cmd.startsWith("ls") ||
    cmd.startsWith("pwd") ||
    cmd.startsWith("cat ") ||
    cmd.startsWith("head ")
  ) {
    return true;
  }
  return false;
}

export function approvalHeadline(actor: string, card: OptionCardLike): string {
  const effectiveActor = sanitizeText(actor) || extractActorFromTitle(card.title) || "Bot";
  const safeHost = sanitizeText(card.hostLabel) || "this computer";

  const rawCmd = sanitizeText(card.details || card.subtitle);
  if (rawCmd && !rawCmd.includes("\n") && rawCmd.length <= 40 && isCommandLineTool(card)) {
    return `${effectiveActor} wants to run ${rawCmd} on ${safeHost}`;
  }

  if (card.actionSummary) {
    const summary = sanitizeText(card.actionSummary);
    if (summary.toLowerCase().startsWith("run ")) {
      const lower = summary[0].toLowerCase() + summary.slice(1);
      if (lower.toLowerCase().includes(" on ")) {
        return `${effectiveActor} wants to ${lower}`;
      }
      return `${effectiveActor} wants to ${lower} on ${safeHost}`;
    }
    if (summary.toLowerCase().startsWith("use ")) {
      const lower = summary[0].toLowerCase() + summary.slice(1);
      if (lower.toLowerCase().includes(" on ")) {
        return `${effectiveActor} wants to ${lower}`;
      }
      return `${effectiveActor} wants to ${lower} on ${safeHost}`;
    }
    if (summary.toLowerCase().includes(" on ")) {
      return `${effectiveActor} wants to run ${summary}`;
    }
    return `${effectiveActor} wants to ${summary} on ${safeHost}`;
  }

  if (card.toolLabel) {
    const cleanTool = sanitizeText(card.toolLabel);
    if (cleanTool.toLowerCase() === "computer") {
      return `${effectiveActor} wants to use the computer on ${safeHost}`;
    }
    if (cleanTool.toLowerCase() === "terminal") {
      const readOnly = isApprovalReadOnly(card);
      return `${effectiveActor} wants to run ${readOnly ? "a read-only command" : "a command"} on ${safeHost}`;
    }
    return `${effectiveActor} wants to run ${cleanTool.toLowerCase()} on ${safeHost}`;
  }

  const readOnly = isApprovalReadOnly(card);
  return `${effectiveActor} wants to run ${readOnly ? "a read-only tool" : "a tool"} on ${safeHost}`;
}

export function approvalChangeDescription(card: OptionCardLike): string {
  if (isApprovalReadOnly(card)) {
    return "Does not change anything · read-only";
  }
  if (card.changeSummary && card.changeSummary.trim().toLowerCase() !== "nothing; read-only") {
    return `Changes files or system state · ${sanitizeText(card.changeSummary)}`;
  }
  if (card.executiveSummary) {
    return `Changes files or system state · ${sanitizeText(card.executiveSummary)}`;
  }
  return "Changes files or system state";
}

export function approvalScope(card: OptionCardLike): string {
  if (card.allowKey) {
    if (card.hostLabel) {
      return `${card.hostLabel} (${card.allowKey})`;
    }
    return card.allowKey;
  }
  if (card.hostLabel) return card.hostLabel;
  if (card.resourceSummary) return sanitizeText(card.resourceSummary);
  return "local";
}

export function toolApprovalPresentation(actor: string, card: OptionCardLike): ToolApprovalPresentation {
  const headline = approvalHeadline(actor, card);
  const changeDescription = approvalChangeDescription(card);
  const isReadOnly = isApprovalReadOnly(card);
  const rawTool = sanitizeText(card.tool || card.toolLabel || "unknown");
  const rawCommand = sanitizeText(card.details || card.subtitle);
  const scope = approvalScope(card);

  const lines = [`Tool: ${rawTool}`];
  if (rawCommand) lines.push(`Command: ${rawCommand}`);
  lines.push(`Scope: ${scope}`);
  const detailsText = lines.join("\n");

  return {
    headline,
    changeDescription,
    isReadOnly,
    rawTool,
    rawCommand,
    scope,
    detailsText,
  };
}
