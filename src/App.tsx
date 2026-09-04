import { useEffect, useRef, useState } from "react";
import { Loader2, Menu } from "lucide-react";
import { StoreProvider, useStore } from "@/state/store";
import { Onboarding } from "@/components/Onboarding";
import { emailGateDone, initAnalytics } from "@/lib/analytics";
import { unreadConversationCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import { ComputerPanel } from "@/components/ComputerPanel";
import { InspectorPanel } from "@/components/InspectorPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { RoutinesPage } from "@/components/RoutinesPage";
import { NoEngines } from "@/components/NoEngines";
import { CommandPalette } from "@/components/CommandPalette";
import { BrowserWorkspace } from "@/components/BrowserWorkspace";
import { SkillRecorderPage } from "@/components/SkillRecorderPage";
import { TeamMapPage } from "@/components/TeamMapPage";
import { isDesktopDemoMode } from "@/lib/desktop-demo";
import {
  conversationNavOrder,
  neighborConversationId,
  saveRightRailOpen,
  shellColumnVisibility,
} from "@/lib/shell-layout";
import { loadSidebarDensity } from "@/lib/sidebar-preferences";

function useViewportWidth() {
  const [width, setWidth] = useState(() => globalThis.innerWidth || 1280);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function Shell() {
  const { state, dispatch } = useStore();
  const unreadCount = unreadConversationCount(state.bots, state.groups, state.showBotChannels);
  const viewportWidth = useViewportWidth();
  const [leftDensity] = useState(() => loadSidebarDensity());
  const layout = shellColumnVisibility(viewportWidth, {
    leftDensity,
    rightUserCollapsed: !state.computerOpen,
  });
  // Mobile-only drawer state. Above md, none of these properties are emitted
  // at all — Sidebar scopes every mobile class with max-md: rather than
  // cancelling them with md:, which would still emit a translate value and
  // turn the aside into a containing block for its fixed descendants (see
  // Sidebar.tsx's className comment).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [browserWorkspaceBotId, setBrowserWorkspaceBotId] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const group = state.groups.find((g) => g.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);
  const showRightRail =
    layout.right === "open" &&
    Boolean(bot) &&
    !state.settingsOpen &&
    !state.inspectorOpen &&
    state.activeView === "chat";

  useEffect(() => {
    saveRightRailOpen(state.computerOpen);
  }, [state.computerOpen]);

  // Nothing on this machine can run a bot. A missing cloud login does not
  // count — that CLI can still host a local model. Wait for the first
  // /api/instances response before deciding: an empty list means "not asked
  // yet", and flashing the setup screen at every launch would be worse.
  const noEngines =
    state.connected &&
    state.instances.length > 0 &&
    !state.instances.some((i) => i.snapshot.state === "available");

  // App-wide shortcuts: ⌘N new bot · ⌘1–9 jump to bot · ⌘⇧[ / ⌘⇧] prev/next.
  // Kept deliberately small; every panel already closes on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey) {
        if (state.pluginsOpen) {
          e.preventDefault();
          dispatch({ type: "togglePlugins", open: false });
          return;
        }
        if (state.appSettingsOpen) {
          e.preventDefault();
          dispatch({ type: "toggleAppSettings", open: false });
          return;
        }
        if (state.settingsOpen) {
          e.preventDefault();
          dispatch({ type: "toggleSettings", open: false });
          return;
        }
        if (state.inspectorOpen) {
          e.preventDefault();
          dispatch({ type: "toggleInspector", open: false });
          return;
        }
        if (state.computerOpen && layout.right === "open") {
          e.preventDefault();
          dispatch({ type: "toggleComputer", open: false });
          return;
        }
        if (drawerOpen) {
          e.preventDefault();
          setDrawerOpen(false);
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const bots = state.bots.filter((b) => !b.hidden);
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "newBot" });
      } else if (/^[1-9]$/.test(e.key)) {
        const target = bots[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          dispatch({ type: "select", id: target.id });
        }
      } else if (e.shiftKey && (e.key === "[" || e.key === "]")) {
        const ids = conversationNavOrder(
          state.bots.map((bot) => ({ id: bot.id, hidden: bot.hidden })),
          state.groups.map((group) => ({ id: group.id })),
        ).map((row) => row.id);
        const next = neighborConversationId(ids, state.selectedId, e.key === "]" ? 1 : -1);
        if (next) {
          e.preventDefault();
          dispatch({ type: "select", id: next });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.bots, state.groups, state.selectedId, state.pluginsOpen, state.appSettingsOpen, state.settingsOpen, state.inspectorOpen, state.computerOpen, layout.right, drawerOpen, dispatch]);

  useEffect(() => {
    window.ogb?.setUnreadCount?.(unreadCount);
  }, [unreadCount]);

  // Warm connected-account state as soon as the local server is available.
  // The modal then opens with the correct Connect/Add account buttons and
  // quietly revalidates instead of rediscovering every account from scratch.
  useEffect(() => {
    if (!state.connected) return;
    void preloadConnectedApps().catch(() => {});
  }, [state.connected]);

  // Picking a conversation closes the drawer: on a phone the chat is what you
  // asked for, and leaving the list up would hide it. Watching activeView too
  // catches re-selecting the bot that is already current from another view —
  // the reducer switches the view without changing selectedId. pluginsOpen
  // and settingsOpen cover the same idea from a different trigger: close the
  // drawer whenever an action opens something over the chat.
  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    if (browserWorkspaceBotId && (state.activeView !== "chat" || state.selectedId !== browserWorkspaceBotId)) {
      setBrowserWorkspaceBotId(null);
    }
  }, [browserWorkspaceBotId, state.activeView, state.selectedId]);

  const openBrowserWorkspace = (botId: string) => {
    dispatch({ type: "toggleComputer", open: false });
    setBrowserWorkspaceBotId(botId);
  };
  const closeBrowserWorkspace = () => {
    setBrowserWorkspaceBotId(null);
    dispatch({ type: "toggleComputer", open: true });
  };

  // The viewer outlives ComputerPanel and can target any bot, so release control
  // here (always mounted) when a bot's viewer closes. release() is idempotent.
  useEffect(() => {
    return window.ogb?.desktopViewer?.onState((viewer) => {
      if (viewer.open || !viewer.contextId) return;
      const botId = viewer.contextId;
      void fetch(`/api/bots/${botId}/computer/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((snap) => {
          if (snap) dispatch({ type: "computerControl", botId, held: snap.held === true, helpReason: snap.helpReason ?? null });
        })
        .catch(() => {});
      void fetch(`/api/bots/${botId}/computer/viewer-close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    });
  }, [dispatch]);

  return (
    <div
      className="flex h-full flex-col"
      data-shell-left={layout.left}
      data-shell-right={layout.right}
    >
      {/* fixed-position popup, bottom-left — outside the layout flow */}
      <UpdateBanner />
      <div className="relative flex min-h-0 flex-1">
      {layout.left === "overlay" && (
        <button
          type="button"
          ref={menuButtonRef}
          aria-label="Open bot list"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="shell-icon-btn absolute left-3 top-2.5 z-30 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Menu size={18} />
        </button>
      )}
      {layout.left === "overlay" && drawerOpen && (
        <div
          aria-hidden
          onMouseDown={(e) => e.target === e.currentTarget && setDrawerOpen(false)}
          className="absolute inset-0 z-30 bg-black/50"
        />
      )}
      <Sidebar
        open={drawerOpen}
        overlay={layout.left === "overlay"}
        onClose={() => {
          setDrawerOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      {state.activeView === "team-map" ? (
        <TeamMapPage />
      ) : state.activeView === "routines" ? (
        <RoutinesPage />
      ) : state.activeView === "skill-recorder" ? (
        <SkillRecorderPage />
      ) : browserWorkspaceBotId && bot && bot.id === browserWorkspaceBotId ? (
        <BrowserWorkspace bot={bot} onClose={closeBrowserWorkspace} />
      ) : noEngines ? (
        <NoEngines />
      ) : group ? (
        <GroupView key={group.id} group={group} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No bots yet" : "Connecting to the bot server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-raised px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {showRightRail && bot && <ComputerPanel bot={bot} onExpandBrowser={openBrowserWorkspace} />}
      {state.inspectorOpen && bot && <InspectorPanel bot={bot} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
      {/* mounted after the modals: same z-50 tier, so DOM order keeps the
          palette on top when one of them is open underneath */}
      <CommandPalette />
      </div>
    </div>
  );
}

import { isWebClientMode } from "@/lib/web-client-mode";
import { WebClientApp } from "@/components/WebClientShell";

export default function App() {
  if (isWebClientMode()) return <WebClientApp />;
  const [gated, setGated] = useState(() => !isDesktopDemoMode() && !emailGateDone());
  useEffect(() => {
    initAnalytics();
  }, []);
  return (
    <DesktopCapabilitiesProvider>
      <StoreProvider>
        <Shell />
        {gated && <Onboarding onDone={() => setGated(false)} />}
      </StoreProvider>
    </DesktopCapabilitiesProvider>
  );
}
