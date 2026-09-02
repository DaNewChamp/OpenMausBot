// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes five tools that
// let one bot talk to another, routed back through the harness so the
// harness stays the single owner of turns, permissions, and recursion
// limits:
//
//   list_bots()                          → the other bots in this section + their status
//   ask_bot(bot_id, msg)                 → send a short question, wait, return
//                                          the reply (or a still-working note)
//   delegate_bot(bot_id, msg, reason?)   → hand real work to a peer ASYNC: returns
//                                          immediately, the peer runs after your
//                                          current turn finishes, the user sees
//                                          the peer's reply as its own turn
//   create_bot(name, role, instructions, …) → Chiefs can add a specialist to
//                                          their own section
//   configure_bot(bot_id, …)             → Chiefs can retarget a teammate's
//                                          engine, model, or reasoning
//   run_on_bridge(command, bridge?, …)   → run a shell command on a paired home bridge
//   run_on_ssh_target(command, target, bridge?) → SSH alias via bridge (~/.ssh/config)
//   Local VM phone/desktop routes relay to bridges when OMB_LOCAL_VM_RELAY=1 or
//   the harness has no local docker but an online bridge advertises local-vm.
//   list_rooms / create_room / update_room  → multi-bot channels (Chief manages)
//   list_routines / create_routine / run_routine → scheduled tasks
//   request_credential(id, reason?)       → show a secure, allowlisted key card
//
// The first-party Hermes connector (bridge/src/hermes-vbot-mcp.ts) exposes this
// same approved tool set over a loopback MCP facade. The facade argv and
// Hermes config receive only a socket path and bot scope — never OMB_COMMS_TOKEN.
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { CREDENTIAL_TARGETS, isCredentialTargetId } from "../../shared/credential-request.ts";

const HARNESS = () => process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = () => process.env.OMB_BOT_ID ?? "";
const THREAD_ID = () => process.env.OMB_THREAD_ID ?? "";
const TOKEN = () => process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = () => Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;
const MAX_CREATED_PER_TURN = 4;
let createdThisTurn = 0;

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in your OpenMausBot section you can message, with their model and whether they're busy. Call this before ask_bot or delegate_bot to discover who's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send a short question to another bot in your section and wait for its reply. Use this only when you need their answer before you can continue. For real work or anything that may take more than a brief reply, use delegate_bot instead. If they are still working when the wait ends, you get a still-working note (not a failure) and their result appears in the conversation later.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "delegate_bot",
    description:
      "Hand real work or a long-running task to another bot ASYNCHRONOUSLY: returns immediately and the peer runs after your current turn finishes. Prefer this over ask_bot for anything that looks like a job rather than a short question. The user sees the peer's reply as its own turn; you do NOT receive the reply inline.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What the peer should do / answer." },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "create_bot",
    description:
      "Create a specialist or sub-chief in your section. Section Chiefs and team leads (titles like Chief of Investments) may use this. Pass role for the job title and instructions for how they work. Optional reports_to sets their manager (defaults: sub-chiefs report to you; Chief-created 'Chief of …' roles report to the section Chief).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short, unique display name for the specialist." },
        role: { type: "string", description: "The specialist's job title or role (for example Chief of Investments)." },
        instructions: { type: "string", description: "What this specialist is responsible for and how it should work." },
        reports_to: { type: "string", description: "Optional manager bot id (from list_bots)." },
        engine: { type: "string", description: "Optional provider instance id from list_bots / the desktop picker (defaults to your engine)." },
        model: { type: "string", description: "Optional model id for that engine (defaults to your model or the engine default)." },
        effort: {
          type: "string",
          description: "Optional reasoning level offered by that engine (for example low, medium, high, xhigh). Omit to inherit yours when compatible.",
        },
        fast_mode: {
          type: "boolean",
          description: "When true, turns prefer the fastest available engine (Codex, then Claude/Cursor, then Grok) with low effort.",
        },
      },
      required: ["name", "role", "instructions"],
    },
  },
  {
    name: "configure_bot",
    description:
      "Update another bot's role (title), instructions, engine, model, or reasoning. Section Chiefs may configure anyone in the section; team leads may configure direct reports. The bot must be idle for engine changes.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The teammate's id (from list_bots)." },
        role: { type: "string", description: "Optional new job title." },
        instructions: { type: "string", description: "Optional new instructions / about text." },
        reports_to: { type: ["string", "null"], description: "Section Chief only: change who they report to, or null to clear." },
        engine: { type: "string", description: "Optional provider instance id." },
        model: { type: "string", description: "Optional model id for that engine." },
        effort: {
          type: ["string", "null"],
          description: "Optional reasoning level, or null to clear it.",
        },
        fast_mode: {
          type: "boolean",
          description: "Enable or disable fast mode (Codex first, then Claude/Cursor, then Grok).",
        },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "configure_bot_runtime",
    description:
      "Convert a teammate between a provider engine and a native Hermes profile on a paired computer. Autonomous calls wait for the user's approval. Never include tokens, secret paths, or session ids.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The teammate's id (from list_bots)." },
        placement: { type: "string", enum: ["provider", "local", "bridge"], description: "Destination runtime kind." },
        instance_id: { type: "string", description: "Provider instance id when placement is provider." },
        model: { type: "string", description: "Optional provider model id." },
        profile: { type: "string", description: "Hermes profile slug when placement is local or bridge." },
        bridge_id: { type: "string", description: "Paired computer/bridge id when placement is bridge." },
        context_mode: { type: "string", enum: ["summary", "none"], description: "Whether to send a sanitized handoff summary." },
      },
      required: ["bot_id", "placement"],
    },
  },
  {
    name: "run_on_bridge",
    description:
      "Run a shell command on a registered home bridge (Mac mini, Pi, etc.) through the cloud harness. Use bridge name when you know it (for example Mac mini); omit to use the freshest online bridge. For Local VM status/actions, use the bot local-computer API (relayed automatically when configured). Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run on the bridge host." },
        bridge: { type: "string", description: "Optional bridge display name from the harness bridge list." },
        cwd: { type: "string", description: "Optional working directory on the bridge host." },
        timeout_ms: { type: "number", description: "Optional timeout in milliseconds (default 60000)." },
      },
      required: ["command"],
    },
  },
  {
    name: "run_on_ssh_target",
    description:
      "Run a command on a named SSH target from harness config (bridgeSshTargets) through a home bridge. The bridge uses its own ~/.ssh/config alias. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Remote shell command to execute." },
        target: { type: "string", description: "Named target key from harness bridgeSshTargets config." },
        bridge: { type: "string", description: "Optional bridge display name; defaults to the target mapping or freshest ssh-forward bridge." },
        cwd: { type: "string", description: "Optional remote working directory." },
        timeout_ms: { type: "number", description: "Optional timeout in milliseconds (default 60000)." },
      },
      required: ["command", "target"],
    },
  },
  {
    name: "list_rooms",
    description:
      "List multi-bot rooms/channels in this V Bot workspace that you belong to. Each room has an id, member bots, and optional bulletin.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_room",
    description:
      "Create a multi-bot room/channel for selected bots in your section. Only a section's Chief of Staff may use this. Members must be in the same section.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for the room (optional; defaults from members)." },
        member_ids: {
          type: "array",
          items: { type: "string" },
          description: "Bot ids to include (from list_bots).",
        },
        bulletin: { type: "string", description: "Optional pinned note shown at the top of the room." },
      },
      required: ["member_ids"],
    },
  },
  {
    name: "update_room",
    description:
      "Rename a room, change its bulletin, or adjust membership. Only a section's Chief of Staff may use this.",
    inputSchema: {
      type: "object",
      properties: {
        room_id: { type: "string", description: "Room id from list_rooms." },
        name: { type: "string", description: "New display name." },
        bulletin: { type: "string", description: "New bulletin text (empty string clears it)." },
        member_ids: {
          type: "array",
          items: { type: "string" },
          description: "Replacement member list.",
        },
      },
      required: ["room_id"],
    },
  },
  {
    name: "list_routines",
    description:
      "List scheduled and recurring tasks (routines) in your section — yours and teammates' when you are Chief.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_routine",
    description:
      "Schedule a recurring or one-shot task for a bot. Chiefs may schedule for teammates; other bots may schedule only for themselves. Use schedule_type once (at unix ms) or daily (HH:MM + optional weekdays 0=Sun..6=Sat).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short routine title." },
        prompt: { type: "string", description: "What the bot should do each run." },
        bot_id: { type: "string", description: "Bot to run it (defaults to you)." },
        run_on: { type: "string", enum: ["maus", "cloud"], description: "Where to run: maus uses the bot's engine; cloud uses its box VM." },
        schedule_type: { type: "string", enum: ["once", "daily"], description: "once = single run; daily = repeating." },
        at: { type: "number", description: "For once: unix timestamp in milliseconds." },
        time: { type: "string", description: "For daily: local time HH:MM (24h)." },
        weekdays: {
          type: "array",
          items: { type: "number" },
          description: "For daily: which weekdays (0=Sun..6=Sat). Omit for every day.",
        },
        duration_minutes: { type: "number", description: "Optional max runtime per run." },
        enabled: { type: "boolean", description: "Whether the routine starts enabled (default true)." },
      },
      required: ["name", "prompt", "schedule_type"],
    },
  },
  {
    name: "run_routine",
    description: "Run a routine immediately (manual trigger). You may run your own routines; Chiefs may run any routine in the section.",
    inputSchema: {
      type: "object",
      properties: {
        routine_id: { type: "string", description: "Routine id from list_routines." },
      },
      required: ["routine_id"],
    },
  },
  {
    name: "request_credential",
    description:
      "Ask the user for a supported API key through OpenMausBot's secure credential card. Use this instead of asking them to paste a secret into chat. The secret is saved by the desktop app and is never returned to you. After calling this tool, end the turn; OpenMausBot resumes the task after the user saves or declines.",
    inputSchema: {
      type: "object",
      properties: {
        credential_id: {
          type: "string",
          enum: Object.keys(CREDENTIAL_TARGETS),
          description: "The credential the current task requires.",
        },
        reason: {
          type: "string",
          description: "Optional short, non-sensitive explanation of why the task needs it.",
        },
      },
      required: ["credential_id"],
    },
  },
  {
    name: "skills_list",
    description: "List this bot's imported skills and staged skill drafts awaiting your approval.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_view",
    description: "Read an imported skill's SKILL.md before deciding whether to update it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name from skills_list." } },
      required: ["name"],
    },
  },
  {
    name: "skill_manage",
    description: "Stage a new or updated SKILL.md for the user to review. It is never enabled until the user confirms the in-app card.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update"] },
        skill_md: { type: "string", description: "Complete SKILL.md including YAML frontmatter." },
        gist: { type: "string", description: "Short summary shown on the approval card." },
        source: { type: "string", description: "What workflow, URL, folder, or conversation this came from." },
      },
      required: ["action", "skill_md"],
    },
  },
];

export const AGENT_PROXY_TOOL_NAMES = TOOLS.map((tool) => tool.name);

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS() + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN()}`, ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

export async function executeAgentsProxyTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID())}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this section yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      const stack = [
        `engine: ${b.engine ?? "unknown"}`,
        `model: ${b.model}`,
        b.effort ? `reasoning: ${b.effort}` : null,
      ].filter(Boolean).join(", ");
      const reports = b.reportsToName ? `, reports to ${b.reportsToName}` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, ${stack}${reports}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID(), fromThreadId: THREAD_ID(), toBotId, message, depth: DEPTH() }),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.pending) {
      return {
        text:
          typeof r.text === "string" && r.text.trim()
            ? r.text
            : `${r.botName ?? "That bot"} is still working. This is not a failure. The reply will appear in the conversation when they finish.`,
      };
    }
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID(),
      fromThreadId: THREAD_ID(),
      toBotId,
      message,
      depth: DEPTH(),
    };
    if (reason) body.reason = reason;
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    // Fire-and-forget by contract: the harness returns immediately, the
    // peer turn runs after our current turn finishes.
    return { text: typeof r.message === "string" ? r.message : "Delegation queued." };
  }
  if (name === "create_bot") {
    const botName = String(args.name ?? "").trim();
    const role = String(args.role ?? "").trim();
    const instructions = String(args.instructions ?? "").trim();
    if (!botName || !role || !instructions) {
      return { text: "create_bot needs name, role, and instructions.", isError: true };
    }
    if (createdThisTurn >= MAX_CREATED_PER_TURN) {
      return { text: `You can create at most ${MAX_CREATED_PER_TURN} bots in one turn. Use the team you have before adding more.`, isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID(),
        fromThreadId: THREAD_ID(),
        name: botName,
        role,
        instructions,
        ...(args.reports_to ? { reports_to: String(args.reports_to) } : {}),
        ...(args.engine ? { engine: String(args.engine) } : {}),
        ...(args.model ? { model: String(args.model) } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        ...(args.fast_mode === true ? { fastMode: true } : {}),
      }),
    });
    createdThisTurn += 1;
    const effort = r.effort ? `, reasoning: ${r.effort}` : "";
    const reports = r.reportsToBotId ? `, reports to id ${r.reportsToBotId}` : "";
    return {
      text: `Created @${r.name ?? botName} in ${r.section ?? "General"} [id: ${r.id}, engine: ${r.engine ?? "unknown"}, model: ${r.model}${effort}${reports}]. Assign work with delegate_bot.`,
    };
  }
  if (name === "configure_bot") {
    const botId = String(args.bot_id ?? "").trim();
    if (!botId) return { text: "configure_bot needs bot_id.", isError: true };
    const payload: Record<string, unknown> = {
      fromBotId: BOT_ID(),
      fromThreadId: THREAD_ID(),
      botId,
    };
    if (args.engine) payload.engine = String(args.engine);
    if (args.model) payload.model = String(args.model);
    if (args.effort !== undefined) payload.effort = args.effort;
    if (args.role) payload.role = String(args.role);
    if (args.instructions) payload.instructions = String(args.instructions);
    if (args.reports_to !== undefined) payload.reports_to = args.reports_to;
    if (args.fast_mode !== undefined) payload.fastMode = Boolean(args.fast_mode);
    const r = await api(`/api/internal/configure-bot`, { method: "POST", body: JSON.stringify(payload) });
    const effort = r.effort ? `, reasoning: ${r.effort}` : "";
    const role = r.title ? `, role: ${r.title}` : "";
    return {
      text: `Updated @${r.name ?? "bot"} [id: ${r.id}] to engine ${r.engine ?? "unknown"}, model ${r.model}${effort}${role}.`,
    };
  }
  if (name === "configure_bot_runtime") {
    const botId = String(args.bot_id ?? "").trim();
    const placement = String(args.placement ?? "").trim();
    if (!botId) return { text: "configure_bot_runtime needs bot_id.", isError: true };
    if (placement !== "provider" && placement !== "local" && placement !== "bridge") {
      return { text: "configure_bot_runtime needs placement of provider, local, or bridge.", isError: true };
    }
    let binding: Record<string, unknown>;
    if (placement === "provider") {
      const instanceId = String(args.instance_id ?? args.engine ?? "").trim();
      if (!instanceId) return { text: "configure_bot_runtime needs instance_id for a provider runtime.", isError: true };
      binding = { kind: "provider", instanceId };
      if (args.model) binding.model = String(args.model);
    } else if (placement === "local") {
      const profile = String(args.profile ?? "").trim();
      if (!profile) return { text: "configure_bot_runtime needs profile for a local Hermes runtime.", isError: true };
      binding = { kind: "hermes", placement: { kind: "local", profile }, bindingVersion: 2 };
    } else {
      const profile = String(args.profile ?? "").trim();
      const bridgeId = String(args.bridge_id ?? "").trim();
      if (!profile || !bridgeId) {
        return { text: "configure_bot_runtime needs bridge_id and profile for a bridge Hermes runtime.", isError: true };
      }
      binding = { kind: "hermes", placement: { kind: "bridge", bridgeId, profile }, bindingVersion: 2 };
    }
    const r = await api(`/api/internal/bots/${encodeURIComponent(botId)}/runtime-binding`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID(),
        fromThreadId: THREAD_ID(),
        targetBotId: botId,
        binding,
        contextMode: args.context_mode === "summary" ? "summary" : "none",
        userRequested: false,
      }),
    });
    const text = typeof r.summary === "string" && r.summary.trim() ? r.summary : "Runtime conversion submitted.";
    if (r.status === "error") return { text, isError: true };
    return { text };
  }
  if (name === "run_on_bridge") {
    const command = String(args.command ?? "").trim();
    if (!command) return { text: "run_on_bridge needs command.", isError: true };
    const body: Record<string, unknown> = { command, fromBotId: BOT_ID(), fromThreadId: THREAD_ID() };
    if (args.bridge) body.bridge = String(args.bridge);
    if (args.cwd) body.cwd = String(args.cwd);
    if (args.timeout_ms != null) body.timeoutMs = Number(args.timeout_ms);
    const r = await api("/api/internal/bridge/shell", { method: "POST", body: JSON.stringify(body) });
    const exitCode = r.exitCode ?? "?";
    const stdout = String(r.stdout ?? "").trim();
    const stderr = String(r.stderr ?? "").trim();
    const parts = [`Bridge ${r.bridgeName ?? "unknown"} exit ${exitCode}`];
    if (r.truncated === true) parts.push("[output truncated at 1 MB]");
    if (stdout) parts.push(`stdout:\n${stdout}`);
    if (stderr) parts.push(`stderr:\n${stderr}`);
    return { text: parts.join("\n\n"), isError: Number(r.exitCode) !== 0 };
  }
  if (name === "run_on_ssh_target") {
    const command = String(args.command ?? "").trim();
    const target = String(args.target ?? "").trim();
    if (!command) return { text: "run_on_ssh_target needs command.", isError: true };
    if (!target) return { text: "run_on_ssh_target needs target.", isError: true };
    const body: Record<string, unknown> = { command, target, fromBotId: BOT_ID(), fromThreadId: THREAD_ID() };
    if (args.bridge) body.bridge = String(args.bridge);
    if (args.cwd) body.cwd = String(args.cwd);
    if (args.timeout_ms != null) body.timeoutMs = Number(args.timeout_ms);
    const r = await api("/api/internal/bridge/ssh", { method: "POST", body: JSON.stringify(body) });
    const exitCode = r.exitCode ?? "?";
    const stdout = String(r.stdout ?? "").trim();
    const stderr = String(r.stderr ?? "").trim();
    const parts = [`SSH target ${target} via bridge ${r.bridgeName ?? "unknown"} exit ${exitCode}`];
    if (r.truncated === true) parts.push("[output truncated at 1 MB]");
    if (stdout) parts.push(`stdout:\n${stdout}`);
    if (stderr) parts.push(`stderr:\n${stderr}`);
    return { text: parts.join("\n\n"), isError: Number(r.exitCode) !== 0 };
  }
  if (name === "list_rooms") {
    const r = await api(`/api/internal/rooms?self=${encodeURIComponent(BOT_ID())}`);
    const rooms = (r.rooms as Array<Json>) ?? [];
    if (!rooms.length) return { text: "No multi-bot rooms in your section yet." };
    const lines = rooms.map((room) => {
      const members = Array.isArray(room.memberNames) ? (room.memberNames as string[]).join(", ") : "";
      const bulletin = room.bulletin ? ` — bulletin: ${String(room.bulletin).slice(0, 120)}` : "";
      return `- ${room.name} [id: ${room.id}, section: ${room.section ?? "General"}, members: ${members}]${bulletin}`;
    });
    return { text: `Rooms you belong to:\n${lines.join("\n")}` };
  }
  if (name === "create_room") {
    const memberIds = Array.isArray(args.member_ids) ? args.member_ids.map(String).filter(Boolean) : [];
    if (!memberIds.length) return { text: "create_room needs at least one member_id.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID(),
      fromThreadId: THREAD_ID(),
      memberIds,
    };
    if (args.name) body.name = String(args.name);
    if (args.bulletin) body.bulletin = String(args.bulletin);
    const r = await api("/api/internal/create-room", { method: "POST", body: JSON.stringify(body) });
    return {
      text: `Created room "${r.name ?? "room"}" [id: ${r.id}, thread: ${r.threadId}] with ${Array.isArray(r.memberIds) ? (r.memberIds as string[]).length : memberIds.length} bot(s).`,
    };
  }
  if (name === "update_room") {
    const roomId = String(args.room_id ?? "").trim();
    if (!roomId) return { text: "update_room needs room_id.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID(),
      fromThreadId: THREAD_ID(),
    };
    if (args.name !== undefined) body.name = String(args.name);
    if (args.bulletin !== undefined) body.bulletin = String(args.bulletin);
    if (args.member_ids !== undefined) {
      body.memberIds = Array.isArray(args.member_ids) ? args.member_ids.map(String).filter(Boolean) : [];
    }
    const r = await api(`/api/internal/rooms/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { text: `Updated room "${r.name ?? roomId}" [id: ${r.id}].` };
  }
  if (name === "list_routines") {
    const r = await api(`/api/internal/routines?self=${encodeURIComponent(BOT_ID())}`);
    const routines = (r.routines as Array<Json>) ?? [];
    if (!routines.length) return { text: "No routines in your section yet." };
    const lines = routines.map((routine) => {
      const schedule = routine.schedule as Json | undefined;
      const sched =
        schedule?.type === "once"
          ? `once @ ${new Date(Number(schedule.at)).toISOString()}`
          : schedule?.type === "daily"
            ? `daily ${schedule.time}${Array.isArray(schedule.weekdays) ? ` days ${(schedule.weekdays as number[]).join(",")}` : ""}`
            : "unknown";
      const bot = String(routine.botId ?? "unknown");
      return `- ${routine.name} [id: ${routine.id}, bot: ${bot}, ${sched}${routine.enabled === false ? ", paused" : ""}]`;
    });
    return { text: `Routines in your section:\n${lines.join("\n")}` };
  }
  if (name === "create_routine") {
    const routineName = String(args.name ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    const scheduleType = String(args.schedule_type ?? "").trim();
    if (!routineName || !prompt || !scheduleType) {
      return { text: "create_routine needs name, prompt, and schedule_type.", isError: true };
    }
    let schedule: Json;
    if (scheduleType === "once") {
      const at = Number(args.at);
      if (!Number.isFinite(at)) return { text: "create_routine with schedule_type once needs at (unix ms).", isError: true };
      schedule = { type: "once", at };
    } else if (scheduleType === "daily") {
      const time = String(args.time ?? "").trim();
      if (!/^\d{2}:\d{2}$/.test(time)) {
        return { text: "create_routine with schedule_type daily needs time as HH:MM.", isError: true };
      }
      schedule = {
        type: "daily",
        time,
        weekdays: Array.isArray(args.weekdays) ? args.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6],
      };
    } else {
      return { text: "schedule_type must be once or daily.", isError: true };
    }
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID(),
      fromThreadId: THREAD_ID(),
      name: routineName,
      prompt,
      schedule,
      enabled: args.enabled !== false,
    };
    if (args.bot_id) body.botId = String(args.bot_id);
    if (args.run_on === "cloud" || args.run_on === "maus") body.runOn = args.run_on;
    if (args.duration_minutes != null) body.durationMinutes = Number(args.duration_minutes);
    const r = await api("/api/internal/create-routine", { method: "POST", body: JSON.stringify(body) });
    const routine = (r.routine ?? r) as Json;
    return { text: `Created routine "${routine.name ?? routineName}" [id: ${routine.id}, bot id: ${routine.botId ?? BOT_ID()}].` };
  }
  if (name === "run_routine") {
    const routineId = String(args.routine_id ?? "").trim();
    if (!routineId) return { text: "run_routine needs routine_id.", isError: true };
    const r = await api(`/api/internal/run-routine/${encodeURIComponent(routineId)}`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID(), fromThreadId: THREAD_ID() }),
    });
    const run = (r.run ?? r) as Json;
    return { text: `Routine run queued [run id: ${run.id}, status: ${run.status ?? "queued"}].` };
  }
  if (name === "skills_list") {
    const r = await api(`/api/internal/skills?fromBotId=${encodeURIComponent(BOT_ID())}&fromThreadId=${encodeURIComponent(THREAD_ID())}`);
    const skills = Array.isArray(r.skills) ? (r.skills as Json[]) : [];
    const staged = Array.isArray(r.staged) ? (r.staged as Json[]) : [];
    if (!skills.length && !staged.length) return { text: "No imported or staged skills yet." };
    const lines = skills.map((s) => `- ${s.name}${s.enabled ? " (enabled)" : " (disabled)"}: ${s.description ?? ""}`);
    const drafts = staged.map((s) => `- staged ${s.name} (${s.action}): ${s.gist ?? "awaiting review"}`);
    return { text: [...lines, ...drafts].join("\n") };
  }
  if (name === "skill_view") {
    const skill = String(args.name ?? "").trim();
    if (!skill) return { text: "skill_view needs name.", isError: true };
    const r = await api(`/api/internal/skills/${encodeURIComponent(skill)}?fromBotId=${encodeURIComponent(BOT_ID())}&fromThreadId=${encodeURIComponent(THREAD_ID())}`);
    return { text: String(r.text ?? "") };
  }
  if (name === "skill_manage") {
    const action = args.action === "update" ? "update" : args.action === "create" ? "create" : "";
    const skillMd = typeof args.skill_md === "string" ? args.skill_md : "";
    if (!action || !skillMd.trim()) return { text: 'skill_manage needs action "create" or "update" and the full skill_md.', isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID(), fromThreadId: THREAD_ID(), action, skill_md: skillMd,
      ...(typeof args.gist === "string" ? { gist: args.gist } : {}),
      ...(typeof args.source === "string" ? { source: args.source } : {}),
    };
    const r = await api("/api/internal/skills/stage", { method: "POST", body: JSON.stringify(body) });
    return { text: `Staged ${r.action ?? action} skill "${r.name ?? "skill"}". It remains disabled until you confirm the Enable card.` };
  }
  if (name === "request_credential") {
    const credentialId = args.credential_id;
    if (!isCredentialTargetId(credentialId)) {
      return { text: "request_credential needs a supported credential_id.", isError: true };
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 240) : "";
    const r = await api("/api/internal/request-credential", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID(),
        fromThreadId: THREAD_ID(),
        credentialId,
        ...(process.env.OMB_ROOM_THREAD_ID && process.env.OMB_ROOM_GENERATION
          ? {
              roomThreadId: process.env.OMB_ROOM_THREAD_ID,
              roomGeneration: Number(process.env.OMB_ROOM_GENERATION),
            }
          : {}),
        ...(reason ? { reason } : {}),
      }),
    });
    if (r.alreadyConfigured) {
      return { text: `${r.label ?? CREDENTIAL_TARGETS[credentialId].label} is already configured. Continue the task.` };
    }
    return {
      text: `A secure ${r.label ?? CREDENTIAL_TARGETS[credentialId].label} card is now visible to the user. End this turn; OpenMausBot will resume the task after they save or decline. Never ask them to paste the key into chat.`,
    };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await executeAgentsProxyTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (entry.endsWith("agents-proxy.ts") || entry.endsWith("agents-proxy.js")) return true;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg: Json;
    try {
      msg = JSON.parse(t) as Json;
    } catch {
      return;
    }
    void handle(msg).catch((e) => {
      if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
    });
  });
  rl.on("close", () => process.exit(0));
}
