import { resolveBotRuntimeBinding } from "./bot-runtime-binding.ts";
import { sectionKey, type BotRecord, type Store } from "./store.ts";

/** First-party Hermes chiefs may coordinate the hub fleet across sections.
 * Ordinary V Bot bots, including provider-backed chiefs, stay section-scoped. */
export function isTrustedHermesChief(bot: BotRecord): boolean {
  if (!bot.chiefOfStaff) return false;
  const resolved = resolveBotRuntimeBinding(bot);
  return resolved.state === "available" && resolved.value.kind === "hermes";
}

export function canReachPeerBot(actor: BotRecord, target: BotRecord): boolean {
  if (target.id === actor.id || target.hidden) return false;
  if (sectionKey(actor.section) === sectionKey(target.section)) return true;
  return isTrustedHermesChief(actor);
}

export function visiblePeerBots(store: Pick<Store, "bots">, actor: BotRecord): BotRecord[] {
  return store.bots.filter((candidate) => canReachPeerBot(actor, candidate));
}
