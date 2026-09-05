export const HUB_SECTION_TITLE = "Hub";
export const AVAILABLE_COMPUTERS_SECTION_TITLE = "Available computers";
export const AVAILABLE_COMPUTERS_SECTION_FOOTER =
  "Computers connected to this hub run tasks for your bots. They are managed through the hub rather than paired directly with your phone.";

export function computerSummary(hubCount: number, connectedComputerCount: number): string {
  const safeHubs = Math.max(0, hubCount);
  const safeComputers = Math.max(0, connectedComputerCount);
  const hubPart = safeHubs === 1 ? "1 hub" : `${safeHubs} hubs`;
  const computerPart = safeComputers === 1 ? "1 connected computer" : `${safeComputers} connected computers`;
  return `${hubPart} · ${computerPart}`;
}

export function fleetHostStatusText(host: { online?: boolean; stale?: boolean }): string {
  if (host.online && !host.stale) return "Online";
  return "Offline";
}

export function connectedComputerCount(hosts: ReadonlyArray<{ online?: boolean; stale?: boolean }>): number {
  return hosts.filter((h) => h.online && !h.stale).length;
}

export interface BotComputerTargetOption {
  id: "auto" | "specific" | "vm" | "off";
  label: string;
  description: string;
}

export const BOT_COMPUTER_TARGET_OPTIONS: readonly BotComputerTargetOption[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Automatically chooses where to run computer tasks.",
  },
  {
    id: "specific",
    label: "Specific computer",
    description: "Run tasks on a specific computer in your fleet.",
  },
  {
    id: "vm",
    label: "Isolated VM",
    description: "Run browser tasks inside an isolated Chromium container.",
  },
  {
    id: "off",
    label: "Off",
    description: "No computer access for this bot.",
  },
];
