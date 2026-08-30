import type { SidebarDensity } from "./sidebar-preferences";

/** Viewport width where the right rail leaves the flow first. 1024 still
 * shows all three columns so the phase-1 screenshot matches the shell. */
export const SHELL_COLLAPSE_RIGHT_BELOW = 900;

/** Viewport width where the left rail becomes an overlay drawer. */
export const SHELL_COLLAPSE_LEFT_BELOW = 720;

export const SHELL_LEFT_WIDTH_PX = 280;
export const SHELL_LEFT_ICONS_PX = 72;
export const SHELL_RIGHT_WIDTH_PX = 320;
export const SHELL_CONTROL_PX = 44;
export const SHELL_SCREENSHOT_WIDTH = 1024;
export const SHELL_SCREENSHOT_HEIGHT = 648;
export const SHELL_BUBBLE_MAX_RATIO = 0.76;

/** Center column width at the reference three-column canvas. */
export const shellCenterWidthPx = (
  width = SHELL_SCREENSHOT_WIDTH,
  left = SHELL_LEFT_WIDTH_PX,
  right = SHELL_RIGHT_WIDTH_PX,
) => width - left - right;

/** Assistant bubble cap in px at the reference canvas (76% of center). */
export const shellBubbleMaxPx = (
  width = SHELL_SCREENSHOT_WIDTH,
  left = SHELL_LEFT_WIDTH_PX,
  right = SHELL_RIGHT_WIDTH_PX,
  ratio = SHELL_BUBBLE_MAX_RATIO,
) => Math.round(shellCenterWidthPx(width, left, right) * ratio);

export const RIGHT_RAIL_KEY = "vbot.rightRail";

export type ShellColumnState = "open" | "icons" | "hidden" | "overlay";

export interface ShellVisibility {
  left: ShellColumnState;
  right: "open" | "hidden";
  /** Right collapses before left as the window narrows. */
  collapseOrder: readonly ["right", "left"];
}

export function parseRightRailOpen(value: string | null): boolean {
  if (value === "closed") return false;
  return true;
}

export function loadRightRailOpen(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parseRightRailOpen(target?.getItem(RIGHT_RAIL_KEY) ?? null);
  } catch {
    return true;
  }
}

export function saveRightRailOpen(
  open: boolean,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(RIGHT_RAIL_KEY, open ? "open" : "closed");
  } catch {
    // Private browsing may reject localStorage; in-memory state still works.
  }
}

export function shellColumnVisibility(
  width: number,
  opts: {
    leftDensity: SidebarDensity;
    rightUserCollapsed: boolean;
  },
): ShellVisibility {
  const collapseOrder = ["right", "left"] as const;
  if (!Number.isFinite(width) || width <= 0) {
    return { left: "overlay", right: "hidden", collapseOrder };
  }
  const left: ShellColumnState =
    width < SHELL_COLLAPSE_LEFT_BELOW
      ? "overlay"
      : opts.leftDensity === "icons"
        ? "icons"
        : "open";
  const right: "open" | "hidden" =
    opts.rightUserCollapsed || width < SHELL_COLLAPSE_RIGHT_BELOW ? "hidden" : "open";
  return { left, right, collapseOrder };
}

export function leftRailWidthPx(left: ShellColumnState, density: SidebarDensity): number {
  if (left === "hidden") return 0;
  if (left === "icons") return SHELL_LEFT_ICONS_PX;
  if (density === "icons") return SHELL_LEFT_ICONS_PX;
  return SHELL_LEFT_WIDTH_PX;
}

/** Conversation rows after `selectedId` that still have unread. Used by the
 * floating "More unreads" jump control. */
export function unreadAfterSelected<T extends { id: string; unread?: boolean }>(
  rows: readonly T[],
  selectedId: string,
): T[] {
  const index = rows.findIndex((row) => row.id === selectedId);
  const start = index === -1 ? 0 : index + 1;
  return rows.slice(start).filter((row) => row.unread);
}

export function conversationNavOrder<T extends { id: string; hidden?: boolean }>(
  bots: readonly T[],
  groups: readonly T[],
): T[] {
  const visibleBots = bots.filter((bot) => !bot.hidden);
  return [...groups, ...visibleBots];
}

export function neighborConversationId(
  ids: readonly string[],
  selectedId: string,
  direction: -1 | 1,
): string | null {
  if (ids.length === 0) return null;
  const index = ids.indexOf(selectedId);
  if (index === -1) return ids[0] ?? null;
  const next = ids[(index + direction + ids.length) % ids.length];
  return next ?? null;
}
