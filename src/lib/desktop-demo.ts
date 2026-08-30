import type { Bot, ConfigStatus, Group, InstanceInfo, Message } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { conversationTitle } from "@/lib/model-suffix";

export const DESKTOP_DEMO_QUERY = "vbotDemo";

/** Frozen instant for screenshot stability (2026-08-30 11:05 CDT). */
export const DESKTOP_DEMO_NOW = Date.UTC(2026, 7, 30, 16, 5, 0);

const minutesAgo = (minutes: number) => DESKTOP_DEMO_NOW - minutes * 60_000;

export function isDesktopDemoMode(search = desktopDemoSearch()): boolean {
  return new URLSearchParams(search).has(DESKTOP_DEMO_QUERY);
}

export function desktopDemoSearch(): string {
  try {
    return globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}

const DEMO_SCREEN_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
    <rect width="1280" height="800" fill="#1c1c1c"/>
    <rect x="0" y="0" width="1280" height="36" fill="#2a2a2a"/>
    <circle cx="18" cy="18" r="6" fill="#ff5f57"/>
    <circle cx="38" cy="18" r="6" fill="#febc2e"/>
    <circle cx="58" cy="18" r="6" fill="#28c840"/>
    <text x="88" y="23" fill="#c8c8c8" font-size="13" font-family="system-ui,sans-serif">Files</text>
    <rect x="48" y="72" width="88" height="68" rx="8" fill="#3d6ea8"/>
    <rect x="160" y="72" width="88" height="68" rx="8" fill="#c9a227"/>
    <rect x="272" y="72" width="88" height="68" rx="8" fill="#4a8f62"/>
    <rect x="384" y="72" width="88" height="68" rx="8" fill="#7a5ea7"/>
    <text x="56" y="162" fill="#d8d8d8" font-size="12" font-family="system-ui,sans-serif">Home</text>
    <text x="172" y="162" fill="#d8d8d8" font-size="12" font-family="system-ui,sans-serif">Work</text>
    <text x="284" y="162" fill="#d8d8d8" font-size="12" font-family="system-ui,sans-serif">Notes</text>
    <text x="396" y="162" fill="#d8d8d8" font-size="12" font-family="system-ui,sans-serif">Inbox</text>
  </svg>`,
);

export const DESKTOP_DEMO_SCREEN_DATA_URL = `data:image/svg+xml,${DEMO_SCREEN_SVG}`;

function text(
  id: string,
  role: Message["role"],
  body: string,
  at: number,
  extra: Partial<Message> = {},
): Message {
  return { id, role, kind: "text", text: body, at, ...extra };
}

function makeBot(partial: Omit<Bot, "title" | "description" | "notifications"> & Partial<Pick<Bot, "title" | "description" | "notifications">>): Bot {
  return {
    title: partial.title ?? "",
    description: partial.description ?? "",
    notifications: partial.notifications ?? true,
    ...partial,
  };
}

export function desktopDemoBots(): Bot[] {
  const chiefMessages: Message[] = [
    text("m1", "user", "Check the open desk before standup.", minutesAgo(42)),
    text(
      "m2",
      "bot",
      "Vanessa's queue is clear. Ticket `3-open-ticket` still needs the first pass — use first vanessa if you want her to take it.",
      minutesAgo(40),
    ),
    {
      id: "m3",
      role: "bot",
      kind: "activity",
      at: minutesAgo(38),
      tool: { name: "2 messages with Chief Of Investments", ok: true },
      comm: {
        groupId: "g-invest",
        withBotId: "bot-invest",
        withName: "Chief Of Investments",
        withColor: "teal",
      },
    },
    text(
      "m5",
      "bot",
      "On it. PM prediction scan is paused until you resume it from Routines.",
      minutesAgo(8),
    ),
  ];

  return [
    makeBot({
      id: "bot-chief",
      threadId: "thread-chief",
      name: "Chief Keef",
      title: "Chief of Staff",
      color: "orange",
      unread: false,
      chiefOfStaff: true,
      autoApprove: true,
      computer: "vm",
      modelSelection: { instanceId: "demo-grok", model: "super", effort: "medium" },
      messages: chiefMessages,
      activeLeafId: "m5",
    }),
    makeBot({
      id: "bot-risk",
      threadId: "thread-risk",
      name: "Risk",
      color: "yellow",
      unread: true,
      computer: "vm",
      modelSelection: { instanceId: "demo-grok", model: "super", effort: "medium" },
      messages: [text("r1", "bot", "Drawdown stayed inside the band.", minutesAgo(55))],
    }),
    makeBot({
      id: "bot-poly",
      threadId: "thread-poly",
      name: "Polymarket",
      color: "pink",
      unread: true,
      computer: "vm",
      modelSelection: { instanceId: "demo-grok", model: "grok-4", effort: "xhigh" },
      messages: [text("p1", "bot", "Two contracts moved after the print.", minutesAgo(90))],
    }),
    makeBot({
      id: "bot-invest",
      threadId: "thread-invest",
      name: "Chief Of Investments",
      color: "teal",
      unread: false,
      computer: "vm",
      modelSelection: { instanceId: "demo-grok", model: "grok-4", effort: "medium" },
      messages: [text("i1", "bot", "Book is quiet. No new tickets.", minutesAgo(120))],
    }),
    makeBot({
      id: "bot-ops",
      threadId: "thread-ops",
      name: "Ops",
      color: "blue",
      unread: true,
      computer: "off",
      modelSelection: { instanceId: "demo-claude", model: "sonnet", effort: "medium" },
      messages: [text("o1", "user", "Ping when the VM is back.", minutesAgo(200))],
    }),
  ];
}

export function desktopDemoGroups(): Group[] {
  return [
    {
      id: "g-invest",
      threadId: "thread-g-invest",
      name: "Investments",
      memberIds: ["bot-chief", "bot-invest"],
      defaultResponder: { kind: "member", botId: "bot-invest" },
      bulletin: "",
      unread: false,
      createdAt: minutesAgo(400),
      dm: true,
      messages: [],
    },
  ];
}

export function desktopDemoInstances(): InstanceInfo[] {
  return [
    {
      instanceId: "demo-grok",
      driverKind: "grok",
      displayName: "Grok",
      snapshot: { state: "available", authenticated: true, billing: "subscription" },
      models: {
        default: "super",
        options: [
          { id: "super", label: "Super" },
          { id: "grok-4", label: "Large" },
        ],
      },
      capabilities: { computerMcp: true, effortLevels: ["low", "medium", "high", "xhigh"] },
      access: "subscription",
    },
    {
      instanceId: "demo-claude",
      driverKind: "claude",
      displayName: "Claude",
      snapshot: { state: "available", authenticated: true, billing: "subscription" },
      models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }] },
      capabilities: { computerMcp: true, effortLevels: ["low", "medium", "high"] },
      access: "subscription",
    },
  ];
}

export function desktopDemoConfig(): ConfigStatus {
  return {
    composio: { configured: true, mode: "managed" },
    box: { configured: false },
    vps: { configured: true, sshAlias: "homelab" },
    rooms: { turnTimeoutMinutes: 20 },
    localVm: { mode: "per-bot", maxInstances: 3 },
    profile: { name: "Vincent Posival", email: "vincent@posival.com" },
    features: { skillRecorder: false },
  };
}

export function desktopDemoRoutines(): Routine[] {
  const botId = "bot-chief";
  return [
    {
      id: "rtn-pm",
      name: "PM prediction scan",
      prompt: "Scan afternoon prediction markets.",
      botId,
      runOn: "cloud",
      enabled: false,
      schedule: { type: "daily", time: "15:00", weekdays: [1, 2, 3, 4, 5] },
      durationMinutes: 20,
      nextRunAt: null,
      createdAt: minutesAgo(800),
      updatedAt: minutesAgo(30),
    },
    {
      id: "rtn-am",
      name: "AM prediction scan",
      prompt: "Scan morning prediction markets.",
      botId,
      runOn: "cloud",
      enabled: false,
      schedule: { type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] },
      durationMinutes: 20,
      nextRunAt: null,
      createdAt: minutesAgo(900),
      updatedAt: minutesAgo(40),
    },
    {
      id: "rtn-crypto",
      name: "Crypto desk check",
      prompt: "Check the crypto desk.",
      botId,
      runOn: "maus",
      enabled: false,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      durationMinutes: 15,
      nextRunAt: null,
      createdAt: minutesAgo(700),
      updatedAt: minutesAgo(50),
    },
  ];
}

export function desktopDemoFixture() {
  const bots = desktopDemoBots();
  const chief = bots[0]!;
  return {
    bots,
    groups: desktopDemoGroups(),
    instances: desktopDemoInstances(),
    config: desktopDemoConfig(),
    routines: desktopDemoRoutines(),
    runs: [],
    selectedId: chief.id,
    screen: {
      botId: chief.id,
      dataUrl: DESKTOP_DEMO_SCREEN_DATA_URL,
    },
    profileName: "Vincent Posival",
    chiefTitle: conversationTitle(chief.name, chief.modelSelection),
  };
}
