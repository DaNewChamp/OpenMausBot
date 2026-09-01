import type { RoutineManager } from "./routines.ts";
import type { Store } from "./store.ts";
import { hermesGroupMembershipError } from "./hermes-groups.ts";

const sectionKey = (section?: string): string => section?.trim() || "";

export function listRoomsForBot(store: Store, botId: string) {
  const bot = store.bot(botId);
  if (!bot) return [];
  return store.groups
    .filter((group) => !group.dm && group.memberIds.includes(botId))
    .map((group) => ({
      id: group.id,
      name: group.name,
      section: group.section || "General",
      memberIds: group.memberIds,
      memberNames: group.memberIds.map((id) => store.bot(id)?.name).filter(Boolean),
      bulletin: group.bulletin,
      threadId: group.threadId,
    }));
}

export function createRoomForChief(
  store: Store,
  chiefId: string,
  input: { name?: string; memberIds: string[]; bulletin?: string; section?: string },
) {
  const chief = store.bot(chiefId);
  if (!chief?.chiefOfStaff) throw new Error("only a section's Chief of Staff can create rooms");
  const memberIds = [...new Set(input.memberIds.filter((id) => Boolean(store.bot(id))))];
  if (!memberIds.length) throw new Error("a room needs at least one bot");
  const hermesMembers = hermesGroupMembershipError(memberIds);
  if (hermesMembers) throw hermesMembers;
  const section = input.section?.trim() || chief.section;
  if (sectionKey(section) !== sectionKey(chief.section)) {
    throw new Error("rooms must stay in your section");
  }
  for (const id of memberIds) {
    const member = store.bot(id);
    if (!member || sectionKey(member.section) !== sectionKey(chief.section)) {
      throw new Error("every member must be in your section");
    }
  }
  const name = input.name?.trim() || `${store.bot(memberIds[0])!.name} & co.`;
  if (name.length > 100) throw new Error("room name must be at most 100 characters");
  const group = store.createGroup(name, memberIds, false, section);
  if (input.bulletin?.trim()) store.patchGroup(group.id, { bulletin: input.bulletin.trim() });
  return group;
}

export function updateRoomForChief(
  store: Store,
  chiefId: string,
  roomId: string,
  patch: { name?: string; bulletin?: string; memberIds?: string[] },
) {
  const chief = store.bot(chiefId);
  if (!chief?.chiefOfStaff) throw new Error("only a section's Chief of Staff can update rooms");
  const group = store.group(roomId);
  if (!group || group.dm) throw new Error("no such room");
  if (sectionKey(group.section) !== sectionKey(chief.section)) {
    throw new Error("that room belongs to a different section");
  }
  const next: Parameters<Store["patchGroup"]>[1] = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 100) throw new Error("room name must be 1–100 characters");
    next.name = name;
  }
  if (patch.bulletin !== undefined) next.bulletin = patch.bulletin.trim();
  if (patch.memberIds !== undefined) {
    const memberIds = [...new Set(patch.memberIds.filter((id) => Boolean(store.bot(id))))];
    if (!memberIds.length) throw new Error("a room needs at least one bot");
    const hermesMembers = hermesGroupMembershipError(memberIds);
    if (hermesMembers) throw hermesMembers;
    for (const id of memberIds) {
      const member = store.bot(id);
      if (!member || sectionKey(member.section) !== sectionKey(chief.section)) {
        throw new Error("every member must be in your section");
      }
    }
    next.memberIds = memberIds;
  }
  const updated = store.patchGroup(roomId, next);
  if (!updated) throw new Error("no such room");
  return updated;
}

export function listRoutinesForBot(store: Store, botId: string, routines: RoutineManager) {
  const bot = store.bot(botId);
  if (!bot) return [];
  const section = sectionKey(bot.section);
  return routines.listRoutines().filter((routine) => {
    const owner = store.bot(routine.botId);
    return owner && sectionKey(owner.section) === section;
  });
}

export function canManageRoutine(store: Store, actorId: string, routineBotId: string): boolean {
  const actor = store.bot(actorId);
  const owner = store.bot(routineBotId);
  if (!actor || !owner) return false;
  if (actor.chiefOfStaff && sectionKey(actor.section) === sectionKey(owner.section)) return true;
  return actor.id === routineBotId;
}

export function createRoutineForBot(
  store: Store,
  actorId: string,
  routines: RoutineManager,
  input: Record<string, unknown>,
) {
  const actor = store.bot(actorId);
  if (!actor) throw new Error("unknown sender");
  const botId = String(input.botId ?? actor.id);
  if (!canManageRoutine(store, actorId, botId)) {
    throw new Error("you may only schedule routines for yourself unless you are the section Chief");
  }
  if (!store.bot(botId)) throw new Error("no such bot");
  return routines.create({
    name: String(input.name ?? ""),
    prompt: String(input.prompt ?? ""),
    botId,
    runOn: input.runOn === "cloud" ? "cloud" : "maus",
    enabled: input.enabled !== false,
    schedule: input.schedule as never,
    durationMinutes: input.durationMinutes == null ? undefined : Number(input.durationMinutes),
  });
}
