import { sectionKey, type BotRecord, type Store } from "./store.ts";

export const TEAM_LEAD_TITLE_RE = /^Chief of/i;

export type HierarchyBot = Pick<BotRecord, "id" | "section" | "title" | "chiefOfStaff" | "reportsToBotId" | "hidden">;

type BotLookup = Pick<Store, "bots" | "bot">;

/** Sub-chief reporting to the apex Chief of Staff (title starts with "Chief of"). */
export function isTeamLead(bot: Pick<BotRecord, "reportsToBotId" | "title" | "chiefOfStaff">): boolean {
  if (bot.chiefOfStaff) return false;
  return Boolean(bot.reportsToBotId && TEAM_LEAD_TITLE_RE.test(bot.title?.trim() ?? ""));
}

export function canCreateBot(actor: Pick<BotRecord, "chiefOfStaff" | "reportsToBotId" | "title">): boolean {
  return Boolean(actor.chiefOfStaff || isTeamLead(actor));
}

export function canConfigureBot(
  actor: Pick<BotRecord, "id" | "section" | "chiefOfStaff" | "reportsToBotId" | "title">,
  target: Pick<BotRecord, "id" | "section" | "reportsToBotId">,
): boolean {
  if (sectionKey(actor.section) !== sectionKey(target.section)) return false;
  if (actor.chiefOfStaff) return true;
  return isTeamLead(actor) && target.reportsToBotId === actor.id;
}

/** Returns an error message, or null when valid. */
export function validateReportsToAssignment(
  bots: BotRecord[],
  opts: {
    reportsToBotId?: string;
    section: string;
    botId?: string;
    chiefOfStaff?: boolean;
  },
): string | null {
  const { reportsToBotId, section, botId, chiefOfStaff } = opts;
  if (chiefOfStaff && reportsToBotId) {
    return "Chief of Staff cannot report to another bot";
  }
  if (!reportsToBotId) return null;

  if (botId && reportsToBotId === botId) {
    return "a bot cannot report to itself";
  }

  const target = bots.find((b) => b.id === reportsToBotId);
  if (!target || target.hidden) return "reports-to target does not exist";
  if (sectionKey(target.section) !== sectionKey(section)) {
    return "reports-to target must be in the same section";
  }

  const byId = new Map(bots.map((b) => [b.id, b]));
  let cursor: string | undefined = reportsToBotId;
  const seen = new Set<string>();
  while (cursor) {
    if (botId && cursor === botId) return "reports-to would create a cycle";
    if (seen.has(cursor)) return "reports-to would create a cycle";
    seen.add(cursor);
    cursor = byId.get(cursor)?.reportsToBotId;
  }

  return null;
}

export function validateNewBotReportsTo(
  store: BotLookup,
  section: string | undefined,
  reportsToBotId: string,
): string | null {
  return validateReportsToAssignment(store.bots, {
    reportsToBotId,
    section: sectionKey(section),
  });
}

export function validateReportsToForBot(
  store: BotLookup,
  botId: string,
  reportsToBotId?: string | null,
): string | null {
  const bot = store.bot(botId);
  if (!bot) return "no such bot";
  return validateReportsToAssignment(store.bots, {
    reportsToBotId: reportsToBotId ?? undefined,
    section: sectionKey(bot.section),
    botId,
    chiefOfStaff: bot.chiefOfStaff,
  });
}

export function resolveCreateReportsToWithStore(
  store: BotLookup,
  actor: BotRecord,
  reportsToParam: string | undefined,
): { reportsToBotId?: string; error?: string } {
  if (!canCreateBot(actor)) {
    return { error: "only a section Chief or team lead may create operator bots" };
  }
  if (actor.chiefOfStaff) {
    const trimmed = reportsToParam?.trim();
    if (!trimmed) return {};
    if (!store.bot(trimmed)) return { error: "reports-to target does not exist" };
    return { reportsToBotId: trimmed };
  }
  if (isTeamLead(actor)) {
    if (reportsToParam?.trim() && reportsToParam.trim() !== actor.id) {
      return { error: "team leads may only create bots that report to themselves" };
    }
    return { reportsToBotId: actor.id };
  }
  return { error: "only a section Chief or team lead may create operator bots" };
}

export function personaReportingContext(
  bot: Pick<BotRecord, "reportsToBotId">,
  store: BotLookup,
): { reportsToBotId?: string; reportsToName?: string; reportsToTitle?: string } {
  if (!bot.reportsToBotId) return {};
  const manager = store.bot(bot.reportsToBotId);
  if (!manager) return { reportsToBotId: bot.reportsToBotId };
  return {
    reportsToBotId: bot.reportsToBotId,
    reportsToName: manager.name,
    reportsToTitle: manager.title,
  };
}

export interface HierarchyRosterEntry<T extends { id: string; name: string }> {
  bot: T;
  depth: number;
}

/** Depth-first roster with direct reports nested under their manager. */
export function hierarchyRoster<T extends { id: string; name: string; reportsToBotId?: string; hidden?: boolean }>(
  bots: T[],
  rootId: string,
): HierarchyRosterEntry<T>[] {
  const visible = bots.filter((b) => !b.hidden && b.id !== rootId);
  const included = new Set<string>();
  const result: HierarchyRosterEntry<T>[] = [];

  const childrenOf = (parentId: string): T[] =>
    visible.filter(
      (b) =>
        !included.has(b.id) &&
        (b.reportsToBotId === parentId || (parentId === rootId && !b.reportsToBotId)),
    );

  const walk = (parentId: string, depth: number) => {
    const kids = childrenOf(parentId).sort((a, b) => a.name.localeCompare(b.name));
    for (const kid of kids) {
      included.add(kid.id);
      result.push({ bot: kid, depth });
      walk(kid.id, depth + 1);
    }
  };

  walk(rootId, 0);

  for (const orphan of visible.filter((b) => !included.has(b.id)).sort((a, b) => a.name.localeCompare(b.name))) {
    result.push({ bot: orphan, depth: 0 });
  }

  return result;
}
