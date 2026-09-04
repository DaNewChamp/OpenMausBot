/** V Bot platform identity + dynamic tool catalog for every bot turn. */

import { isTeamLead } from "./bot-hierarchy.ts";

export interface SelfAwarenessBot {
  id: string;
  name: string;
  title?: string;
  description?: string;
  section?: string;
  chiefOfStaff?: boolean;
  reportsToBotId?: string;
  reportsToName?: string;
  reportsToTitle?: string;
}

export interface SelfAwarenessIntegrations {
  agents?: unknown;
  composio?: unknown;
  computer?: unknown;
  localComputer?: unknown;
  phone?: unknown;
  dweb?: unknown;
}

export interface SelfAwarenessRoom {
  name: string;
  memberNames: string[];
  userName: string;
}

const AGENTS_TOOLS_CHIEF = [
  "list_bots — roster with ids, titles, reporting lines, engines, models, busy state",
  "ask_bot — short question; wait for inline answer",
  "delegate_bot — hand off real work asynchronously",
  "create_bot — add a specialist or sub-chief (optional reports_to for hierarchy)",
  "configure_bot — update role, instructions, reporting line, engine, or model",
  "run_on_bridge — shell on a paired home bridge (Mac mini, Pi, etc.)",
  "list_rooms — multi-bot channels in this workspace",
  "create_room — open a channel for selected bots (Chief only)",
  "update_room — rename, bulletin, or membership (Chief only)",
  "list_routines — scheduled and recurring tasks",
  "create_routine — schedule a bot task (Chief for team; you may schedule yourself)",
  "run_routine — run a routine now",
  "request_credential — secure in-app API key card",
];

const AGENTS_TOOLS_TEAM_LEAD = [
  "list_bots — roster with ids, titles, reporting lines, and availability",
  "ask_bot — short question; wait for inline answer",
  "delegate_bot — hand off real work asynchronously",
  "create_bot — add a specialist who reports to you",
  "configure_bot — update your direct reports' role, instructions, engine, or model",
  "run_on_bridge — shell on a paired home bridge",
  "list_rooms — multi-bot channels",
  "list_routines — scheduled tasks",
  "create_routine — schedule work for yourself or your reports",
  "run_routine — run a routine now",
  "request_credential — secure in-app API key card",
];

const AGENTS_TOOLS_PEER = [
  "list_bots — roster with ids, titles, and availability",
  "ask_bot — short question; wait for inline answer",
  "delegate_bot — hand off real work asynchronously",
  "run_on_bridge — shell on a paired home bridge",
  "list_rooms — multi-bot channels",
  "list_routines — scheduled tasks (yours and team)",
  "create_routine — schedule a recurring task for yourself",
  "run_routine — run your routine now",
  "request_credential — secure in-app API key card",
];

const LEADING_ROLE_PATTERN = /\b(chief|head|lead|director|manager|officer|vp)\b(?:\s+of)?\s+(.+)/i;

/** A bot named for a role ("Chief of Investments", "Lead, V Bot") wears that
 * title even when the title field is empty. */
export function roleNameAwareness(name: string): string {
  const m = name.match(LEADING_ROLE_PATTERN);
  if (!m) return "";
  const domain = m[2].trim().replace(/\s+/g, " ");
  if (!domain) return "";
  const role = `${m[1].toUpperCase()} OF ${domain.toUpperCase()}`;
  return `Your name is a real title: you are the ${role}. Own that domain, speak with its authority, and delegate what belongs to your team.`;
}

export function botSelfAwarenessPersona(bot: SelfAwarenessBot, room?: SelfAwarenessRoom): string {
  const section = bot.section?.trim() || "General";
  const managerLine =
    bot.reportsToBotId && bot.reportsToName
      ? `You report to ${bot.reportsToName}${bot.reportsToTitle ? ` (${bot.reportsToTitle})` : ""}.`
      : "";
  const teamLeadLine =
    isTeamLead({ title: bot.title ?? "", reportsToBotId: bot.reportsToBotId, chiefOfStaff: bot.chiefOfStaff }) && !bot.chiefOfStaff
      ? "You lead a sub-team — use create_bot to add specialists who report to you."
      : "";
  if (room) {
    return [
      `You are ${bot.name}, a bot in the V Bot room "${room.name}" (OpenMausBot harness).`,
      bot.title ? `Role: ${bot.title}.` : roleNameAwareness(bot.name),
      bot.description && `About: ${bot.description}`,
      `Section: ${section}.`,
      managerLine,
      teamLeadLine,
      `Room members: ${room.memberNames.join(", ")}, and ${room.userName} (the human).`,
      "V Bot is Vincent's multi-bot platform: iPhone, desktop viewer, and cloud harness. You are one agent in a fleet — not a generic chatbot.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `You are ${bot.name}, a personal bot in V Bot (OpenMausBot harness).`,
    bot.title ? `Role: ${bot.title}.` : roleNameAwareness(bot.name),
    bot.description && `About: ${bot.description}`,
    `Section: ${section}.`,
    bot.chiefOfStaff
      ? "You are this section's Chief of Staff — the user's primary coordinator for this team."
      : "",
    managerLine,
    teamLeadLine,
    "V Bot is Vincent's multi-bot platform: iPhone, desktop viewer, and cloud harness. You are one agent in a fleet — not a generic chatbot.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function botSelfAwarenessCatalog(
  bot: SelfAwarenessBot,
  integrations: SelfAwarenessIntegrations,
  opts?: { hasSectionPeers?: boolean },
): string {
  const lines: string[] = [
    "--- V Bot capabilities (this turn) ---",
    "App surface the user sees: 1:1 chats, multi-bot rooms/channels, Tasks & Routines (schedule once or daily), Computer view, approvals, and team map.",
  ];

  if (integrations.agents) {
    const tools = bot.chiefOfStaff
      ? AGENTS_TOOLS_CHIEF
      : isTeamLead({ title: bot.title ?? "", reportsToBotId: bot.reportsToBotId, chiefOfStaff: bot.chiefOfStaff })
        ? AGENTS_TOOLS_TEAM_LEAD
        : AGENTS_TOOLS_PEER;
    lines.push(`Agents tools mounted: ${tools.join("; ")}.`);
    if (!bot.chiefOfStaff && !isTeamLead({ title: bot.title ?? "", reportsToBotId: bot.reportsToBotId, chiefOfStaff: bot.chiefOfStaff }) && opts?.hasSectionPeers) {
      lines.push("Coordinate through ask_bot (brief) or delegate_bot (work). Do not invent teammate results.");
    }
  } else if (opts?.hasSectionPeers) {
    lines.push("Your current engine cannot mount agents tools — ask the user to switch engine before promising team coordination.");
  }

  if (integrations.composio) {
    lines.push(
      "Connected apps (Composio): COMPOSIO_SEARCH_TOOLS → COMPOSIO_GET_TOOL_SCHEMAS → COMPOSIO_MULTI_EXECUTE_TOOL for Gmail, Calendar, Slack, Notion, etc.",
    );
  }
  if (integrations.computer) {
    lines.push("Cloud computer tools mounted (box/VPS desktop): inspect before acting; browser_snapshot/click preferred in Chrome.");
  }
  if (integrations.localComputer) {
    lines.push("Local VM or host computer tools mounted: screenshot/read state first; never type passwords or MFA codes.");
  }
  if (integrations.phone) {
    lines.push("Phone integration mounted for device-side actions exposed by the harness.");
  }
  if (integrations.dweb) {
    lines.push("DWeb tools mounted for decentralized web actions.");
  }

  lines.push(
    "Structural changes (new bots, rooms, team routines) go through your agents tools when mounted — not by asking the user to click settings unless tools are unavailable.",
  );
  lines.push("--- end V Bot capabilities ---");
  return lines.join("\n");
}
