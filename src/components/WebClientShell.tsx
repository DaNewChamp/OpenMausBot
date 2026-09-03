import { useEffect, useState } from "react";
import { Loader2, Menu, RotateCcw, ShieldCheck, Users, X } from "lucide-react";
import { ChatView } from "@/components/ChatView";
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

/**
 * Hub pairing is the only way in. There is no account service behind this
 * client — no directory of systems, no email code — so the gate asks for the
 * one thing that actually works: a pairing code from the hub itself.
 */
export function WebClientGate({
  session,
  onSessionChange,
}: {
  session: WebClientSessionSnapshot;
  onSessionChange: (next: WebClientSessionSnapshot) => void;
}) {
  const [hubUrl, setHubUrl] = useState(() => defaultWebHubUrl());
  const [credential, setCredential] = useState("");
  const [deviceName, setDeviceName] = useState("Web browser");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; kind: PairFailureKind } | null>(null);
  // One idempotency key per pairing attempt. It is held across retries of the
  // same attempt so a resubmit cannot burn a second slot on the hub's pairing
  // window, and replaced only when the user genuinely starts over.
  const [pairRequestId, setPairRequestId] = useState<string | null>(null);

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
      // The hub's own sentences reach the user untouched; only genuinely
      // unknown failures (network, non-JSON) get this client's wording.
      const message = e instanceof Error ? e.message : "Pairing could not finish.";
      const kind = e instanceof HubPairError ? e.kind : "unknown";
      setFailure({ message, kind });
      // A burned window means the next submit is a new attempt, not a retry.
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

  return (
    <div data-web-client-gate className="flex min-h-screen items-center justify-center bg-app px-4 py-8 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/40 sm:p-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-secondary">V Bot · Web</div>
        <h1 className="mt-2 text-[22px] font-semibold tracking-tight">Pair this browser</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Open Phone settings on your computer to start pairing, then enter the code it shows.
        </p>

        <div data-web-pair-form className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-[13px]">
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
          <label className="flex flex-col gap-1.5 text-[13px]">
            Pairing code or invitation
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
            Device name
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
  const { state } = useStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);
  const group = state.groups.find((entry) => entry.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((entry) => entry.id === state.selectedId) ?? state.bots[0]);
  const [viewportWidth, setViewportWidth] = useState(() => globalThis.innerWidth || 1280);
  const mobile = viewportWidth < 768;
  const layout = webClientLayout();

  useEffect(() => {
    if (canCallHubApi()) void preloadConnectedApps();
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(globalThis.innerWidth || 1280);
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!mobile) setDrawerOpen(false);
  }, [mobile]);

  useEffect(() => {
    setRoomInfoOpen(false);
  }, [state.selectedId]);

  return (
    <div
      data-web-client-shell
      data-web-left-rail={layout.leftRail}
      data-web-main={layout.main}
      data-web-right-pane={layout.rightPane}
      data-web-traffic-lights={String(layout.trafficLights)}
      className="relative flex h-screen min-h-0 overflow-hidden bg-app text-ink"
    >
      {mobile && drawerOpen && (
        <button
          type="button"
          aria-label="Close bot list"
          className="absolute inset-0 z-30 cursor-default bg-black/45"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <Sidebar
        web
        open={mobile ? drawerOpen : true}
        overlay={mobile}
        onClose={() => setDrawerOpen(false)}
      />

      <div data-web-main-column className="relative flex min-w-0 flex-1 flex-col bg-app">
        {mobile && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open bot list"
            className="shell-control absolute left-2 top-2 z-20 rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Menu size={18} />
          </button>
        )}
        <div className="flex min-h-0 flex-1">
          {state.activeView === "team-map" ? <TeamMapPage /> : state.activeView === "routines" ? <RoutinesPage /> : state.activeView === "skill-recorder" ? <SkillRecorderPage /> : group ? <GroupView key={group.id} group={group} onOpenInfo={() => setRoomInfoOpen(true)} /> : bot ? <ChatView bot={bot} /> : (
            <div className="flex h-full min-w-0 flex-1 items-center justify-center text-[14px] text-ink-secondary">
              No bots yet
            </div>
          )}
        </div>
      </div>

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
