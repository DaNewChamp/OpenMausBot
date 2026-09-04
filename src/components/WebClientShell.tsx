import { useEffect, useRef, useState } from "react";
import { Loader2, Menu, QrCode, RotateCcw, ShieldCheck, Users, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { ChatView } from "@/components/ChatView";
import { ComputerPanel } from "@/components/ComputerPanel";
import { GroupView } from "@/components/GroupView";
import { BotAvatar } from "@/components/Avatar";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { Sidebar } from "@/components/Sidebar";
import { RoutinesPage } from "@/components/RoutinesPage";
import { SkillRecorderPage } from "@/components/SkillRecorderPage";
import { TeamMapPage } from "@/components/TeamMapPage";
import { StoreProvider, useStore, type Bot, type Group } from "@/state/store";
import { isDesktopDemoMode } from "@/lib/desktop-demo";
import { webClientLayout } from "@/lib/web-client-layout";
import {
  saveRightRailOpen,
  SHELL_COLLAPSE_LEFT_BELOW,
  SHELL_COLLAPSE_RIGHT_BELOW,
} from "@/lib/shell-layout";
import { stateForBot } from "@/lib/mascot";
import {
  canCallHubApi,
  createPairRequestId,
  defaultWebHubUrl,
  HubPairError,
  loadWebClientSession,
  pairDirectHub,
  type PairFailureKind,
  type WebClientSessionSnapshot,
} from "@/lib/web-client-session";
import { WEB_PAIRING_POLL_MS, WebPairingQrSession } from "@/lib/web-pairing-session";
import {
  formatQrCountdown,
  hubUnreachableCopy,
  isHubUnreachableMessage,
  QR_CANCEL_LABEL,
  secondsRemaining,
} from "@/lib/web-pairing-gate";

export const WEB_PAIR_GATE_COPY = {
  title: "Pair this browser",
  enterCode: "Enter pairing code",
  scanQr: "Scan QR code",
  pairingCode: "Pairing code",
  deviceName: "Device name",
  scanHint: "Scan this code with an already-paired iPhone to approve this browser.",
  waiting: "Waiting for your iPhone to approve…",
  expired: "This code expired. Refresh to generate a new one.",
  refresh: "Refresh code",
  cancel: QR_CANCEL_LABEL,
} as const;

/**
 * Hub pairing is the only way in. There is no account service behind this
 * client — no directory of systems, no email code — so the gate asks for the
 * one thing that actually works: a pairing code from the hub itself, or a QR
 * that an already-paired iPhone can approve.
 */
export function WebClientGate({
  session,
  onSessionChange,
}: {
  session: WebClientSessionSnapshot;
  onSessionChange: (next: WebClientSessionSnapshot) => void;
}) {
  const [mode, setMode] = useState<"code" | "qr">("code");
  const [hubUrl, setHubUrl] = useState(() => defaultWebHubUrl());
  const [credential, setCredential] = useState("");
  const [deviceName, setDeviceName] = useState("Web browser");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; kind: PairFailureKind } | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [pairRequestId, setPairRequestId] = useState<string | null>(null);
  const [qrLink, setQrLink] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState<number | null>(null);
  const [qrExpired, setQrExpired] = useState(false);
  const [qrGeneration, setQrGeneration] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const qrSessionRef = useRef<WebPairingQrSession | null>(null);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  const deviceNameRef = useRef(deviceName);
  deviceNameRef.current = deviceName;

  const windowClosed = failure?.kind === "window-closed";

  const pairDirect = async () => {
    const requestId = pairRequestId ?? createPairRequestId();
    if (requestId !== pairRequestId) setPairRequestId(requestId);
    setBusy(true);
    setFailure(null);
    try {
      const hub = await pairDirectHub({
        baseUrl: hubUrl,
        credential,
        deviceName,
        pairRequestId: requestId,
      });
      onSessionChange({ ...session, hub });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Pairing could not finish.";
      const kind = e instanceof HubPairError ? e.kind : "unknown";
      setFailure({ message, kind });
      if (kind === "window-closed") setPairRequestId(null);
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setFailure(null);
    setCredential("");
    setPairRequestId(createPairRequestId());
  };

  useEffect(() => {
    if (mode !== "qr") {
      const previous = qrSessionRef.current;
      qrSessionRef.current = null;
      if (previous) void previous.dispose();
      setQrLink(null);
      setQrExpiresAt(null);
      setQrExpired(false);
      setQrError(null);
      return;
    }
    const qrSession = new WebPairingQrSession();
    qrSessionRef.current = qrSession;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        await qrSession.start({ baseUrl: hubUrl, deviceName: deviceNameRef.current });
        if (cancelled || qrSessionRef.current !== qrSession) {
          await qrSession.dispose();
          return;
        }
        setQrLink(qrSession.link);
        setQrExpiresAt(qrSession.expiresAt);
        setQrError(null);
        const tick = async () => {
          if (cancelled || qrSessionRef.current !== qrSession) return;
          const result = await qrSession.pollOnce();
          if (cancelled || qrSessionRef.current !== qrSession) return;
          if (result === "paired") {
            onSessionChangeRef.current({ ...session, hub: loadWebClientSession().hub });
            return;
          }
          if (result === "pending") {
            timer = setTimeout(() => void tick(), WEB_PAIRING_POLL_MS);
            return;
          }
          // Expired: roll a fresh code so the tab always shows a live QR.
          try {
            await qrSession.refresh({ baseUrl: hubUrl, deviceName: deviceNameRef.current });
            if (cancelled || qrSessionRef.current !== qrSession) return;
            setQrLink(qrSession.link);
            setQrExpiresAt(qrSession.expiresAt);
            timer = setTimeout(() => void tick(), WEB_PAIRING_POLL_MS);
          } catch {
            setQrExpired(true);
          }
        };
        await tick();
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "Pairing could not finish.";
        setQrError(message);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (qrSessionRef.current === qrSession) qrSessionRef.current = null;
      void qrSession.dispose();
    };
  }, [mode, qrGeneration, hubUrl, session]);

  return (
    <div data-web-client-gate className="flex min-h-screen items-center justify-center bg-app px-4 py-8 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/40 sm:p-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-secondary">V Bot · Web</div>
        <h1 className="mt-2 text-[22px] font-semibold tracking-tight">{WEB_PAIR_GATE_COPY.title}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Open Phone settings on your computer to start pairing, then enter the code it shows — or scan the QR
          code with an already-paired iPhone. This browser remembers the pairing, so it is a once-per-device step.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2" role="tablist" aria-label="Pairing method">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "code"}
            data-web-pair-tab="code"
            className={
              mode === "code"
                ? "rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink"
                : "rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-raised"
            }
            onClick={() => setMode("code")}
          >
            {WEB_PAIR_GATE_COPY.enterCode}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "qr"}
            data-web-pair-tab="qr"
            className={
              mode === "qr"
                ? "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink"
                : "inline-flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-raised"
            }
            onClick={() => setMode("qr")}
          >
            <QrCode size={14} />
            {WEB_PAIR_GATE_COPY.scanQr}
          </button>
        </div>

        {mode === "code" ? (
          <div data-web-pair-form data-web-pair-mode="code" className="mt-6 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px]">
              {WEB_PAIR_GATE_COPY.pairingCode}
              <input
                name="credential"
                className="rounded-lg bg-inset px-3 py-2"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                autoComplete="one-time-code"
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              {WEB_PAIR_GATE_COPY.deviceName}
              <input
                name="deviceName"
                className="rounded-lg bg-inset px-3 py-2"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>

            {failure && (
              <div
                role="alert"
                data-pair-failure={failure.kind}
                className={
                  failure.kind === "wrong-code" || failure.kind === "unknown"
                    ? "text-[13px] leading-relaxed text-danger"
                    : "rounded-xl border border-hairline/60 bg-inset px-3 py-3 text-[13px] leading-relaxed"
                }
              >
                <p className={failure.kind === "wrong-code" || failure.kind === "unknown" ? "" : "font-medium text-ink"}>
                  {failure.message}
                </p>
                {failure.kind === "wrong-code" && (
                  <p className="mt-1 text-ink-secondary">
                    Check the code on your computer and try again. Pairing closes after five wrong codes.
                  </p>
                )}
                {windowClosed && (
                  <>
                    <p className="mt-1 text-ink-secondary">
                      That pairing window is closed, so retyping the same code will not work. Start pairing again on
                      your computer, then enter the new code here.
                    </p>
                    <button
                      type="button"
                      onClick={startOver}
                      className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-raised"
                    >
                      <RotateCcw size={14} />
                      Start over with a new code
                    </button>
                  </>
                )}
                {failure.kind === "device-limit" && (
                  <p className="mt-1 text-ink-secondary">
                    Your code is fine — the hub already has as many paired devices as it allows. Remove one on the hub
                    (this browser cannot do it yet), then pair again.
                  </p>
                )}
                {failure.kind === "save-failed" && (
                  <p className="mt-1 text-ink-secondary">The hub could not store this device. Try again in a moment.</p>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={busy || windowClosed || !credential.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50"
              onClick={() => void pairDirect()}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Pair this browser
            </button>
          </div>
        ) : (
          <WebPairQrPane
            link={qrLink}
            expired={qrExpired}
            expiresAt={qrExpiresAt}
            error={
              qrError && isHubUnreachableMessage(qrError)
                ? hubUnreachableCopy({ hubUrl, advancedOpen })
                : qrError
            }
            onRefresh={() => {
              setQrError(null);
              setQrExpired(false);
              setQrLink(null);
              setQrExpiresAt(null);
              setQrGeneration((generation) => generation + 1);
            }}
            onCancel={() => {
              const session = qrSessionRef.current;
              qrSessionRef.current = null;
              if (session) void session.dispose();
              setQrError(null);
              setQrExpired(false);
              setQrLink(null);
              setQrExpiresAt(null);
              setMode("code");
            }}
          />
        )}

        <details className="mt-5 text-[12px] text-ink-secondary" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer">Advanced</summary>
          <label className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink">
            Hub address
            <input
              name="hubUrl"
              className="rounded-lg bg-inset px-3 py-2"
              value={hubUrl}
              onChange={(event) => setHubUrl(event.target.value)}
              placeholder={defaultWebHubUrl()}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </details>
      </div>
    </div>
  );
}

export function WebPairQrPane({
  link,
  expired,
  error,
  expiresAt,
  now: nowProp,
  onRefresh,
  onCancel,
}: {
  link: string | null;
  expired: boolean;
  error?: string | null;
  expiresAt?: number | null;
  now?: number;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const [clock, setClock] = useState(() => nowProp ?? Date.now());
  useEffect(() => {
    if (nowProp != null) {
      setClock(nowProp);
      return;
    }
    setClock(Date.now());
    const id = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [nowProp, expiresAt]);

  const remaining = expiresAt != null ? secondsRemaining(expiresAt, clock) : null;
  const timedOut = remaining === 0;
  const showExpired = expired || timedOut;
  const countdown = remaining != null && remaining > 0 ? formatQrCountdown(remaining) : "";

  return (
    <div data-web-pair-qr data-web-pair-mode="qr" className="mt-6 flex flex-col items-center gap-4">
      <p className="text-center text-[13px] leading-relaxed text-ink-secondary">{WEB_PAIR_GATE_COPY.scanHint}</p>
      {error ? (
        <p role="alert" className="text-center text-[13px] text-danger">{error}</p>
      ) : showExpired ? (
        <p className="text-center text-[13px] text-ink">{WEB_PAIR_GATE_COPY.expired}</p>
      ) : link ? (
        <div className="rounded-2xl bg-white p-3.5" aria-label="Browser pairing QR code">
          <QRCodeSVG value={link} size={180} level="M" bgColor="#ffffff" fgColor="#111111" />
        </div>
      ) : (
        <Loader2 size={22} className="animate-spin text-ink-secondary" />
      )}
      {!error && !showExpired && countdown ? (
        <p data-web-pair-countdown={remaining ?? undefined} aria-live="polite" className="text-[12px] tabular-nums text-ink">
          {countdown}
        </p>
      ) : null}
      {!error && !showExpired && link && <p className="text-[12px] text-ink-secondary">{WEB_PAIR_GATE_COPY.waiting}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          data-web-pair-refresh
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-raised"
        >
          <RotateCcw size={14} />
          {WEB_PAIR_GATE_COPY.refresh}
        </button>
        <button
          type="button"
          data-web-pair-cancel
          onClick={onCancel}
          className="inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-raised"
        >
          {WEB_PAIR_GATE_COPY.cancel}
        </button>
      </div>
    </div>
  );
}

function RoomInfoPanel({ group, onClose }: { group: Group; onClose: () => void }) {
  const { state } = useStore();
  const members = group.memberIds
    .map((id) => state.bots.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Bot => Boolean(candidate));

  return (
    <aside
      aria-label={`${group.name} room info`}
      className="animate-panel-in flex h-full w-[min(320px,100vw)] shrink-0 flex-col border-l border-hairline/40 bg-panel"
    >
      <header className="flex items-center justify-between border-b border-hairline/20 px-4 py-3">
        <span className="text-[15px] font-semibold text-ink">Room info</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close room info"
          className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={17} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="rounded-xl border border-hairline/30 bg-card p-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-full bg-control text-ink-secondary">
              <Users size={18} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-medium text-ink">{group.name}</div>
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {members.length} {members.length === 1 ? "member" : "members"}
              </div>
            </div>
          </div>
        </div>

        <section className="mt-5" aria-labelledby="web-room-members-title">
          <h2 id="web-room-members-title" className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">
            Members
          </h2>
          <div className="mt-2 flex flex-col gap-1">
            {members.map((member) => (
              <div key={member.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-raised/40">
                <BotAvatar bot={member} state={stateForBot(member)} size={30} animated={false} />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{member.name}</div>
                  <div className="truncate text-[11.5px] text-ink-secondary">{member.title || "Bot"}</div>
                </div>
              </div>
            ))}
            {members.length === 0 && <p className="px-2 py-3 text-[13px] text-ink-secondary">No members listed.</p>}
          </div>
        </section>

        {group.bulletin && (
          <section className="mt-5" aria-labelledby="web-room-bulletin-title">
            <h2 id="web-room-bulletin-title" className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">
              Room instructions
            </h2>
            <p className="mt-2 whitespace-pre-wrap rounded-xl border border-hairline/30 bg-card p-3 text-[13px] leading-relaxed text-ink-secondary">
              {group.bulletin}
            </p>
          </section>
        )}
      </div>
    </aside>
  );
}

export function WebClientShell() {
  const { state, dispatch } = useStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);
  const group = state.groups.find((entry) => entry.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((entry) => entry.id === state.selectedId) ?? state.bots[0]);
  const [viewportWidth, setViewportWidth] = useState(() => globalThis.innerWidth || 1280);
  const overlay = viewportWidth < SHELL_COLLAPSE_LEFT_BELOW;
  const chrome = webClientLayout();
  const showRightRail =
    chrome.rightPane === "computer" &&
    state.computerOpen &&
    Boolean(bot) &&
    !state.settingsOpen &&
    state.activeView === "chat" &&
    viewportWidth >= SHELL_COLLAPSE_RIGHT_BELOW;

  useEffect(() => {
    if (canCallHubApi()) void preloadConnectedApps();
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(globalThis.innerWidth || 1280);
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!overlay) setDrawerOpen(false);
  }, [overlay]);

  useEffect(() => {
    setRoomInfoOpen(false);
  }, [state.selectedId]);

  useEffect(() => {
    saveRightRailOpen(state.computerOpen);
  }, [state.computerOpen]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [state.selectedId, state.activeView, state.pluginsOpen, state.settingsOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey) return;
      if (state.pluginsOpen) {
        event.preventDefault();
        dispatch({ type: "togglePlugins", open: false });
        return;
      }
      if (state.appSettingsOpen) {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (state.settingsOpen) {
        event.preventDefault();
        dispatch({ type: "toggleSettings", open: false });
        return;
      }
      if (showRightRail) {
        event.preventDefault();
        dispatch({ type: "toggleComputer", open: false });
        return;
      }
      if (drawerOpen) {
        event.preventDefault();
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, drawerOpen, showRightRail, state.appSettingsOpen, state.pluginsOpen, state.settingsOpen]);

  return (
    <div
      data-web-client-shell
      data-web-left-rail={chrome.leftRail}
      data-web-main={chrome.main}
      data-web-right-pane={chrome.rightPane}
      data-web-traffic-lights={String(chrome.trafficLights)}
      data-web-overlay={String(overlay)}
      data-web-computer={String(showRightRail)}
      className="relative flex h-screen min-h-0 overflow-hidden bg-app text-ink"
    >
      {overlay && drawerOpen && (
        <button
          type="button"
          aria-label="Close bot list"
          className="absolute inset-0 z-30 cursor-default bg-black/45"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <Sidebar
        web
        open={overlay ? drawerOpen : true}
        overlay={overlay}
        onClose={() => setDrawerOpen(false)}
      />

      <div data-web-main-column className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        {overlay && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open bot list"
            className="shell-control absolute left-2 top-2 z-20 cursor-pointer rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Menu size={18} />
          </button>
        )}
        <div className="flex min-h-0 min-w-0 flex-1">
          {state.activeView === "team-map" ? <TeamMapPage /> : state.activeView === "routines" ? <RoutinesPage /> : state.activeView === "skill-recorder" ? <SkillRecorderPage /> : group ? <GroupView key={group.id} group={group} onOpenInfo={() => setRoomInfoOpen(true)} /> : bot ? <ChatView bot={bot} /> : (
            <div className="flex h-full min-w-0 flex-1 items-center justify-center text-[14px] text-ink-secondary">
              No bots yet
            </div>
          )}
        </div>
      </div>

      {showRightRail && bot && <ComputerPanel bot={bot} />}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {roomInfoOpen && group && <RoomInfoPanel group={group} onClose={() => setRoomInfoOpen(false)} />}
      {state.appSettingsOpen && <SettingsModal />}
      {state.pluginsOpen && <PluginsPanel />}
    </div>
  );
}

export function WebClientApp() {
  const [session, setSession] = useState(() => loadWebClientSession());

  // The public demo is intentionally self-contained: StoreProvider hydrates
  // its frozen fixture and never calls a hub, so designers can open the web
  // chrome without a pairing code or persisted credentials.
  if (!isDesktopDemoMode() && !canCallHubApi()) {
    return <WebClientGate session={session} onSessionChange={setSession} />;
  }
  return (
    <StoreProvider>
      <WebClientShell />
    </StoreProvider>
  );
}

export default WebClientApp;
