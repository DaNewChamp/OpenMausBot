import { track } from "@/lib/analytics";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
  ArrowDownToLine,
  BellDot,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ClipboardCopy,
  Copy,
  Crown,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  Network,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Users,
  Eye,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, type Bot, type Group } from "@/state/store";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { nextRename } from "@/lib/rename";
import { downloadAllBots } from "@/lib/team-files";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import { TeamLibraryPanel, type TeamImportResult } from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import {
  loadSidebarDensity,
  saveSidebarDensity,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import { conversationTitle, modelSuffix } from "@/lib/model-suffix";
import { unreadAfterSelected } from "@/lib/shell-layout";
import { rosterGroups } from "@/lib/bot-channel";
import { phoneSettingsAction, SidebarPhoneButton, SidebarPhonePrompt } from "./SidebarPhoneButton";

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.ogb?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "disabled"
      ? "Private update channel not configured"
      : status === "available"
        ? `Version ${s?.version ?? ""} available — download`
        : status === "downloading"
          ? s?.percent == null
            ? "Starting download…"
            : `Downloading… ${Math.round(s.percent)}%`
          : status === "downloaded"
            ? `Version ${s?.version ?? ""} ready — restart to update`
            : status === "installing"
              ? "Restarting to update…"
              : status === "checking"
                ? "Checking for updates…"
                : upToDate
                  ? "You're up to date"
                  : "Check for updates";

  return (
    <button
      onClick={() => {
        if (status === "disabled") return;
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative flex size-10 items-center justify-center rounded-md text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting for you…";
  if (bot.busy) return "Working…";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  const last = group.messages.at(-1);
  if (!last) return "No messages yet";
  const text = last.kind === "activity" && last.tool ? last.tool.name : (last.text ?? "");
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** Room avatar: 2–3 overlapping mauses in the same 56px slot a bot gets. */
function StackedMauses({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-10" : "size-14";
  const singleSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={30} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({
  group,
  density,
  onMenu,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-lg text-left",
        density === "icons" ? "justify-center px-1 py-1.5" : "gap-2.5 px-2 py-1.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedMauses members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-medium text-ink">{group.name}</span>
          {last && <span className="shrink-0 text-[11px] text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="shell-unread shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={`Rename ${group.name}`}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label="Save channel name"
            title="Save"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel channel rename"
            title="Cancel"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          Rename Channel
        </button>
      )}
      <button
        onClick={() => {
          onClose();
          onMoveToSection(group.id);
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <FolderPlus size={16} className="text-ink-secondary" />
        Move to context
      </button>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy conversation ID
      </button>
      <button
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        Delete Channel
      </button>
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New Channel</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Channel name (for example, Website launch)"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Context (optional): Work, Personal, Client…"
          aria-label="Channel context"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint="Create a bot first — channels are made of bots."
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          Create Channel{picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}
        </button>
      </div>
    </div>
  );
}

/** Labeled divider between sidebar sections. Same typographic register as
 * EngineGroupLabel so the sidebar reads as one system. */
function SectionDivider({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 px-2 pb-0.5 pt-2 first:pt-0" data-section={name}>
      <span className="sr-only">{name}</span>
    </div>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-2 shadow-2xl shadow-black/60"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Move to context
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New context…"
          aria-label="New context name"
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          Add
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            Remove from context
          </button>
        </>
      )}
    </div>
  );
}

function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? "Choose another Chief of Staff first"
    : visibleBotCount <= 1
      ? "Keep at least one active bot"
      : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(
          <Crown size={16} className={bot.chiefOfStaff ? "text-accent" : "text-ink-secondary"} />,
          bot.chiefOfStaff ? "Remove Chief of Staff" : "Make Chief of Staff",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { chiefOfStaff: !bot.chiefOfStaff } }),
          {
            disabled: !bot.chiefOfStaff && !canCoordinate,
            hint: !bot.chiefOfStaff && !canCoordinate ? "Choose a Claude or ACP engine first" : undefined,
          },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to section", () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          "Archive",
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(<Trash2 size={16} />, "Delete", () => dispatch({ type: "deleteBot", botId: bot.id }), {
          danger: true,
        }),
      ]}
    </div>
  );
}

function PinnedChiefCard({
  bot,
  density,
  onMenu,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
}) {
  const { state, dispatch } = useStore();
  if (density === "icons") {
    return (
      <BotListItem
        bot={bot}
        density={density}
        onMenu={onMenu}
        onArchive={() => {}}
        archiveDisabled
      />
    );
  }
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const suffix = modelSuffix(bot.modelSelection);
  return (
    <div className="flex justify-center px-2 pb-1.5 pt-0.5">
      <button
        type="button"
        onClick={() => dispatch({ type: "select", id: bot.id })}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
        }}
        aria-label={conversationTitle(bot.name, bot.modelSelection)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-[var(--shell-pin-width)] max-w-full flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-center",
          selected ? "border-hairline/40 bg-raised/40" : "border-hairline/20 bg-card/40 hover:bg-raised/25",
        )}
      >
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visibleMessages(bot) })}
          size={56}
          animated={Boolean(bot.busy) || Boolean(bot.unread)}
        />
        <div className="min-w-0 w-full">
          <div className="truncate text-[13px] font-semibold leading-tight text-ink">
            {bot.name}
            {suffix ? <span className="font-medium text-ink-secondary"> · {suffix}</span> : null}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">Chief of Staff</div>
        </div>
      </button>
    </div>
  );
}

function BotListItem({
  bot,
  density,
  onMenu,
  onArchive,
  archiveDisabled,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
}) {
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : 36;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const suffix = modelSuffix(bot.modelSelection);
  const rowClass = cn(
    "flex w-full items-center rounded-lg text-left",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : "gap-2.5 px-2 py-1.5 pr-10",
    selected ? "bg-raised/80" : "hover:bg-raised/40",
  );
  const body = (
    <>
      <BotAvatar
        bot={bot}
        state={stateForBot({ ...bot, messages: visible })}
        size={avatarSize}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
        // Motion means something is happening. A resting bot holds a resting
        // pose — N idle rows bobbing at display rate was most of the app's
        // visible-idle CPU (states are keyword-derived, so "working" can be
        // decorative; busy/unread/motion are the real signals).
        animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
      />
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[14px] font-medium text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[14px] font-medium"
            />
            {suffix && !renaming && (
              <span className="shrink-0 text-[13px] font-medium text-ink-secondary">· {suffix}</span>
            )}
          </span>
          {last && !renaming && (
            <span className="shrink-0 text-[11px] text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[12.5px] text-ink-secondary">
            <span className="truncate">{preview(bot)}</span>
          </span>
          {bot.unread && (
            <span className="shell-unread shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };

  // Keep the rename <input> out of role="button" — a button's descendants
  // are presentational, which hides the field from assistive tech.
  if (renaming) {
    return (
      <div className={rowClass} onContextMenu={onContextMenu}>
        {body}
      </div>
    );
  }

  return (
    <div className="group relative" title={iconOnly ? bot.name : undefined}>
      <div
        role="button"
        tabIndex={0}
        aria-label={iconOnly ? bot.name : undefined}
        onClick={() => dispatch({ type: "select", id: bot.id })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {iconOnly && bot.unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {!iconOnly && <button
        type="button"
        disabled={archiveDisabled}
        onClick={() => onArchive(bot)}
        aria-label={`Archive ${bot.name}`}
        title={
          bot.chiefOfStaff
            ? "Choose another Chief of Staff first"
            : archiveDisabled
              ? "Keep at least one active bot"
              : `Archive ${bot.name}`
        }
        className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
      >
        <Archive size={14} />
      </button>}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(`${bot.name} restored`);
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(`${bots.length} ${bots.length === 1 ? "bot" : "bots"} restored`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Archived bots</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Conversations are kept until you choose to delete a bot.</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                Restore all
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Close archived bots"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{bots.length} archived</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} state="happy" size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || "Bot"}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({
  open,
  onClose,
  overlay = false,
  web = false,
}: {
  open: boolean;
  onClose: () => void;
  overlay?: boolean;
  /** Hosted V Bot uses the Grok-style rail and never renders window chrome. */
  web?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [teamLibraryOpen, setTeamLibraryOpen] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const showBotChannels = state.showBotChannels;
  const [exportingTeam, setExportingTeam] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<{
    error: boolean;
    text: string;
    undo?: TeamImportResult;
    restoreBot?: { id: string; name: string };
  } | null>(null);
  const [query, setQuery] = useState("");
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    return window.ogb?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      setTeamLibraryOpen(true);
    });
  }, []);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const exportAllBots = async () => {
    setExportingTeam(true);
    setTeamFeedback(null);
    try {
      const exported = await downloadAllBots();
      track("team_exported", { members: exported.members, scope: "all_visible" });
      setTeamFeedback({ error: false, text: `${exported.members} bots exported` });
    } catch (cause) {
      setTeamFeedback({
        error: true,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExportingTeam(false);
    }
  };

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      await Promise.all([
        ...result.importedRoutineIds.map((routineId) =>
          api(`/api/routines/${routineId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "routineDeleted", routineId }),
          ),
        ),
        ...result.importedGroupIds.map((groupId) =>
          api(`/api/groups/${groupId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "groupDeleted", groupId }),
          ),
        ),
      ]);
      const archiveNew = await Promise.all(
        result.importedBotIds.map((botId) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: true, chiefOfStaff: false }),
          }),
        ),
      );
      for (const response of archiveNew) dispatch({ type: "botPatched", bot: response.bot });

      const previousChiefs = result.archived.filter((bot) => bot.chiefOfStaff);
      const restoreOthers = await Promise.all(
        result.archived
          .filter((bot) => !bot.chiefOfStaff)
          .map((bot) =>
            api(`/api/bots/${bot.id}`, {
              method: "PATCH",
              body: JSON.stringify({ hidden: false }),
            }),
          ),
      );
      for (const response of restoreOthers) dispatch({ type: "botPatched", bot: response.bot });
      const restoredChiefs = await Promise.all(
        previousChiefs.map((previousChief) =>
          api(`/api/bots/${previousChief.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false, chiefOfStaff: true }),
          }),
        ),
      );
      for (const response of restoredChiefs) dispatch({ type: "botPatched", bot: response.bot });
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: "Previous team restored" });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: `${bot.name} archived`,
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: `${bot.name} restored` });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = !web && capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser" && !web;
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  const matchingBots = state.bots
    .filter((b) => !b.hidden)
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    );
  const unsectionedChief = matchingBots.find((bot) => bot.chiefOfStaff && !bot.section);
  const sectionChiefs = matchingBots.filter((bot) => bot.chiefOfStaff && bot.section);
  const sectionedBots = matchingBots
    .filter((bot) => !bot.chiefOfStaff && bot.section)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleBots = matchingBots
    .filter((bot) => !bot.chiefOfStaff && !bot.section)
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  const visibleGroups = rosterGroups(
    state.groups.filter((g) => !q || g.name.toLowerCase().includes(q)),
    showBotChannels,
  );
  const sectionedGroups = visibleGroups.filter((g) => g.section);
  const unsectionedGroups = visibleGroups.filter((g) => !g.section);
  // sections keep first-appearance order within the current list; a section
  // whose members all moved away (or fell out of the filter) simply vanishes
  const sectionNames: string[] = [];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedGroups) {
    if (!sectionNames.includes(group.section!)) sectionNames.push(group.section!);
  }
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const pendingTeamUndo = teamFeedback?.undo;
  const pendingBotUndo = teamFeedback?.restoreBot;
  const moreUnreads = unreadAfterSelected(
    [
      ...(unsectionedChief ? [{ id: unsectionedChief.id, unread: unsectionedChief.unread }] : []),
      ...unsectionedGroups.map((group) => ({ id: group.id, unread: group.unread })),
      ...visibleBots.map((candidate) => ({ id: candidate.id, unread: candidate.unread })),
      ...sectionedBots.map((candidate) => ({ id: candidate.id, unread: candidate.unread })),
    ],
    state.selectedId,
  );
  const jumpToUnread = () => {
    const next = moreUnreads[0];
    if (next) dispatch({ type: "select", id: next.id });
  };

  return (
    <aside
      aria-label="Bots and navigation"
      className={cn(
        "shell-rail flex h-full shrink-0 flex-col border-r border-hairline/30 bg-panel transition-[width] duration-200",
        density === "icons"
          ? "w-[var(--shell-left-icons)]"
          : web
            ? "w-[248px]"
            : "w-[var(--shell-left-width)]",
        // Overlay only: the rail leaves the flow. Do not emit a translate when
        // in-flow — Tailwind v4's native `translate` makes this a containing
        // block for fixed menus (+ and NewRoomPanel).
        overlay && "absolute inset-y-0 left-0 z-40 transition-transform duration-200",
        overlay && (open ? "translate-x-0" : "-translate-x-full"),
      )}
    >
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex items-center pb-1 pt-3", density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-3")}
        style={windowDragStyle}
      >
        {web && density !== "icons" ? (
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-secondary">Bots</div>
        ) : macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-[var(--shell-traffic-inset)] shrink-0"} />
        ) : browser ? (
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : (
          <div />
        )}
        <div className="relative flex items-center" style={windowNoDragStyle}>
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label="New or share"
            className="shell-control flex items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="New or share"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div className={cn(
                "absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  New Bot
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  New Channel
                </button>
                <button
                  onClick={() => {
                    dispatch({ type: "setShowBotChannels", show: !showBotChannels });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {showBotChannels ? (
                    <Check size={16} className="text-accent" />
                  ) : (
                    <Eye size={16} className="text-ink-secondary" />
                  )}
                  {showBotChannels ? "Hide bot channels" : "Show bot channels"}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    void exportAllBots();
                  }}
                  disabled={exportingTeam}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {exportingTeam ? <Loader2 size={16} className="animate-spin text-ink-secondary" /> : <ArrowDownToLine size={16} className="text-ink-secondary" />}
                  {exportingTeam ? "Exporting…" : "Export all bots"}
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setTeamLibraryOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  Teams
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">Archived bots</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
                <div className="mx-2 my-1 border-t border-hairline/40" />
                <button
                  type="button"
                  onClick={() => {
                    setPlusOpen(false);
                    toggleCollapsed();
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  {density === "icons" ? <PanelLeftOpen size={16} className="text-ink-secondary" /> : <PanelLeftClose size={16} className="text-ink-secondary" />}
                  {density === "icons" ? "Expand sidebar" : "Collapse to avatars"}
                </button>
                {(["comfortable", "compact", "icons"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setPlusOpen(false);
                      setDensity(option);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between px-3.5 py-2 text-left text-[13px] hover:bg-raised/70",
                      density === option ? "text-accent" : "text-ink",
                    )}
                  >
                    {option === "icons" ? "Avatars only" : option === "compact" ? "Compact list" : "Comfortable list"}
                    {density === option && <Check size={14} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      <div className={cn("pt-1 pb-2", density === "icons" ? "hidden" : "px-3")}>
        <div className="shell-search flex items-center gap-2 bg-raised/70 px-3">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder={web ? "Find bots or rooms" : "Search"}
            aria-label={web ? "Find bots or rooms and messages" : "Search bots and messages"}
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {!unsectionedChief && sectionChiefs.length === 0 && visibleBots.length === 0 && sectionedBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {unsectionedChief && (
            <PinnedChiefCard bot={unsectionedChief} density={density} onMenu={setMenu} />
          )}
          {unsectionedGroups.length > 0 && density !== "icons" && (
            web ? (
              <div className="px-2 pb-0.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Rooms</div>
            ) : <SectionDivider name="Channels" />
          )}
          {unsectionedGroups.map((g) => (
            <GroupListItem key={g.id} group={g} density={density} onMenu={setRoomMenu} />
          ))}
          {visibleBots.map((b) => (
            <BotListItem
              key={b.id}
              bot={b}
              density={density}
              onMenu={setMenu}
              onArchive={(bot) => void archiveBot(bot)}
              archiveDisabled={activeBotCount <= 1}
            />
          ))}
          {sectionNames.map((name) => (
            <Fragment key={name}>
              {density !== "icons" && <SectionDivider name={name} />}
              {sectionChiefs
                .filter((bot) => bot.section === name)
                .map((bot) => (
                  <BotListItem
                    key={bot.id}
                    bot={bot}
                    density={density}
                    onMenu={setMenu}
                    onArchive={(candidate) => void archiveBot(candidate)}
                    archiveDisabled
                  />
                ))}
              {sectionedGroups
                .filter((g) => g.section === name)
                .map((g) => (
                  <GroupListItem key={g.id} group={g} density={density} onMenu={setRoomMenu} />
                ))}
              {sectionedBots
                .filter((b) => b.section === name)
                .map((b) => (
                  <BotListItem
                    key={b.id}
                    bot={b}
                    density={density}
                    onMenu={setMenu}
                    onArchive={(bot) => void archiveBot(bot)}
                    archiveDisabled={activeBotCount <= 1}
                  />
                ))}
            </Fragment>
          ))}
          <SearchResults query={query} onLanded={() => setQuery("")} />
        </div>
        {moreUnreads.length > 0 && density !== "icons" && (
          <div className="sticky bottom-2 flex justify-center pt-2">
            <button
              type="button"
              onClick={jumpToUnread}
              className="shell-control inline-flex items-center gap-1.5 rounded-full bg-accent px-3 text-[13px] font-medium text-white shadow-lg hover:brightness-110"
            >
              <ArrowDown size={14} />
              More unreads
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className={cn("border-t border-hairline/20 pb-2.5 pt-1.5", density === "icons" ? "px-2" : "px-2.5")}>
        <div className={cn("mb-1 space-y-0.5 px-1", density === "icons" && "hidden")}>
          <details className="group/more">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-ink-secondary marker:content-none hover:bg-raised/40 hover:text-ink [&::-webkit-details-marker]:hidden">
              More
            </summary>
            <div className="pb-1 pl-2">
              <button
                onClick={() => dispatch({ type: "showTeamMap" })}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] transition-colors",
                  state.activeView === "team-map" ? "bg-raised/60 text-ink" : "text-ink-secondary hover:bg-raised/40 hover:text-ink",
                )}
              >
                <Network size={16} />
                <span className="flex-1">Team map</span>
              </button>
              {skillRecorderEnabled(state.config) && (
                <button
                  onClick={() => dispatch({ type: "showSkillRecorder" })}
                  className={cn(
                    "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] transition-colors",
                    state.activeView === "skill-recorder" ? "bg-raised/60 text-ink" : "text-ink-secondary hover:bg-raised/40 hover:text-ink",
                  )}
                >
                  <Sparkles size={16} />
                  <span className="flex-1">Teach a skill</span>
                </button>
              )}
              <button
                onClick={() => dispatch({ type: "showRoutines" })}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] transition-colors",
                  state.activeView === "routines" ? "bg-raised/60 text-ink" : "text-ink-secondary hover:bg-raised/40 hover:text-ink",
                )}
              >
                <CalendarDays size={16} />
                <span className="flex-1">Tasks &amp; routines</span>
                {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
                  <span className="size-2 rounded-full bg-danger" />
                )}
              </button>
            </div>
          </details>
        </div>
        <button
          onClick={() => dispatch({ type: "togglePlugins", open: true })}
          className={cn("shell-control flex w-full items-center rounded-lg text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "gap-3 px-2")}
          aria-label={density === "icons" ? "Plugins" : undefined}
          title={density === "icons" ? "Plugins" : undefined}
        >
          <Puzzle size={20} className="text-ink-secondary" />
          <span className={cn("text-[14px] text-ink", density === "icons" && "hidden")}>Plugins</span>
        </button>
        {density === "icons" && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
        {density !== "icons" && (
          <div className="mt-1 border-t border-hairline/20 pt-1">
            <SidebarPhonePrompt onOpen={() => dispatch(phoneSettingsAction())} />
          </div>
        )}
        <div className={cn("flex items-center", density === "icons" && "justify-center")}>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className={cn("shell-control flex min-w-0 items-center rounded-lg text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "flex-1 gap-3 px-2")}
            aria-label={web ? "Account settings" : density === "icons" ? "App settings" : undefined}
            title={web ? "Account settings" : density === "icons" ? (state.config?.profile?.name?.trim() || "App settings") : undefined}
          >
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            {web ? (
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Account</span>
                <span className="truncate text-[13px] text-ink">
                  {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
                </span>
              </span>
            ) : (
              <span className={cn("truncate text-[14px] text-ink", density === "icons" && "hidden")}>
                {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
              </span>
            )}
          </button>
          {density !== "icons" && <UpdateButton />}
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } })}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {teamLibraryOpen && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            setTeamLibraryOpen(false);
            setTeamInstallUrl(null);
            setTeamFeedback(
              result.archived.length > 0
                ? {
                    error: false,
                    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
                    undo: result,
                  }
                : {
                    error: false,
                    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
                  },
            );
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              teamFeedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            <div className="flex items-center gap-3">
              <span>{teamFeedback.text}</span>
              {pendingTeamUndo && (
                <button
                  onClick={() => void undoTeamLoad(pendingTeamUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
              {pendingBotUndo && (
                <button
                  onClick={() => void undoBotArchive(pendingBotUndo)}
                  className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
                >
                  Undo
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
