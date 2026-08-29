export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
  section?: string;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits.
const ROSTER_MAX_BOTS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const sectionKey = (section?: string): string => section?.trim() || "";

/** Dynamic system context for a section's Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_BOTS);
  const overflow = team.length - listed.length;
  const roster = team.length
    ? listed
        .map((bot) => {
          const name = clip(bot.name, ROSTER_NAME_MAX);
          const role = clip(bot.title?.trim() || "General assistant", ROSTER_ROLE_MAX);
          const about = bot.description?.trim();
          const availability = bot.busy ? "working right now" : "available";
          return `- ${name} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""} (${availability})`;
        })
        .join("\n") + (overflow > 0 ? `\n- …and ${overflow} more (use list_bots for the full roster).` : "")
    : "- No other visible bots are available yet.";

  const delegation = canDelegate
    ? [
        "Use list_bots to confirm the live roster and IDs. Use ask_bot only for a short question whose answer you need before continuing.",
        "Use delegate_bot to assign real work or a long-running task so you are not stuck waiting; the teammate's result appears in the conversation when they finish.",
        "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, pick a suitable engine/model/reasoning level when the job calls for it, then use delegate_bot to assign its work. Use configure_bot to retarget an idle teammate's engine or reasoning before delegating. Do not create duplicate or unnecessary bots.",
        "Delegate with a clear, self-contained brief. After delegate_bot, tell the user the teammate is working; never invent a result or claim the work is complete until it actually is.",
        "You may consult more than one teammate when the request genuinely benefits, then combine their results into one coherent answer.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

  return [
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    `Current ${sectionName} section team:`,
    roster,
  ].join("\n");
}

/** Non-chief bots in a section with peers. Work goes through delegate_bot;
 * ask_bot stays for short questions whose answer the caller needs inline. */
export function sectionPeerCoordinationPrompt(): string {
  return "You can work with the other bots in your section through the agents tools — list_bots shows who's available. Use ask_bot for a short question whose answer you need before continuing. Use delegate_bot to hand off real work or a long-running task; that returns immediately and the teammate's result appears in the conversation when they finish.";
}

export function taggedPeerNudge(tagged: Array<{ id: string; name: string }>): string {
  if (!tagged.length) return "";
  return ` The user tagged ${tagged
    .map((peer) => `@${peer.name} (bot_id ${peer.id})`)
    .join(" and ")} in their message — bring them in with ask_bot if you need a short answer before continuing, or delegate_bot to hand them the work. Do not claim their work is complete until it actually is.`;
}
