import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Mail,
  Menu,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from "lucide-react";
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
  clearAccountSession,
  completeWebAuthHandoff,
  defaultWebHubUrl,
  fetchAccountUser,
  fetchFleet,
  loadWebClientSession,
  pairDirectHub,
  persistAccountSession,
  pocketIdCallbackURL,
  probePocketId,
  requestAccountOtp,
  startPocketIdSignIn,
  verifyAccountOtp,
  waitForWebAuthHandoff,
  type WebClientSessionSnapshot,
  type WebFleetInstallation,
} from "@/lib/web-client-session";

export function WebClientGate({
  session,
  onSessionChange,
}: {
  session: WebClientSessionSnapshot;
  onSessionChange: (next: WebClientSessionSnapshot) => void;
}) {
  const [mode, setMode] = useState<"choose" | "account" | "direct">("choose");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [hubUrl, setHubUrl] = useState(() => defaultWebHubUrl());
  const [credential, setCredential] = useState("");
  const [deviceName, setDeviceName] = useState("Web browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fleet, setFleet] = useState<WebFleetInstallation[]>(session.fleet);
  const [selectedHub, setSelectedHub] = useState<WebFleetInstallation | null>(null);

  useEffect(() => {
    void probePocketId(session.controlPlaneUrl).then((enabled) => {
      onSessionChange({ ...session, pocketIdEnabled: enabled });
    });
  }, [session.controlPlaneUrl]);

  const refreshAccount = useCallback(async (token: string) => {
    const user = await fetchAccountUser(session.controlPlaneUrl, token);
    const installations = await fetchFleet(session.controlPlaneUrl, token);
    setFleet(installations);
    onSessionChange({ ...session, account: user, accountToken: token, fleet: installations });
  }, [onSessionChange, session]);

  useEffect(() => {
    if (!session.accountToken || session.account) return;
    void refreshAccount(session.accountToken).catch(() => {
      clearAccountSession();
      onSessionChange({ ...session, account: null, accountToken: null, fleet: [] });
    });
  }, [refreshAccount, session]);

  const signInWithOtp = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!otpSent) {
        await requestAccountOtp(session.controlPlaneUrl, email);
        setOtpSent(true);
      } else {
        const verified = await verifyAccountOtp(session.controlPlaneUrl, email, otp);
        persistAccountSession(verified.accountToken);
        await refreshAccount(verified.accountToken);
        setMode("account");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in could not finish.");
    } finally {
      setBusy(false);
    }
  };

  const signInWithPocketId = async () => {
    setBusy(true);
    setError(null);
    try {
      const returnTo = `${globalThis.location?.origin ?? ""}${globalThis.location?.pathname ?? "/"}${globalThis.location?.search || "?client=web"}`;
      const callbackURL = pocketIdCallbackURL(session.controlPlaneUrl, returnTo);
      const url = await startPocketIdSignIn(session.controlPlaneUrl, callbackURL);
      const appOrigin = globalThis.location?.origin ?? "";
      const handoff = waitForWebAuthHandoff(session.controlPlaneUrl, appOrigin);
      const popup = globalThis.open("", "omb_pocketid", "width=520,height=720");
      if (!popup) {
        throw new Error("Allow pop-ups to finish PocketID sign-in.");
      }
      popup.location.href = url;
      const code = await handoff;
      popup.close();
      const token = await completeWebAuthHandoff(session.controlPlaneUrl, code);
      persistAccountSession(token);
      await refreshAccount(token);
      setMode("account");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PocketID sign-in is not available right now. Use email instead.");
    } finally {
      setBusy(false);
    }
  };

  const pairSelectedHub = async () => {
    if (!selectedHub?.endpoint?.url) {
      setError("That system is not reachable yet. Pair directly with its address instead.");
      return;
    }
    setMode("direct");
    setHubUrl(selectedHub.endpoint.url);
  };

  const pairDirect = async () => {
    setBusy(true);
    setError(null);
    try {
      const hub = await pairDirectHub({
        baseUrl: hubUrl,
        credential,
        deviceName,
      });
      onSessionChange({ ...session, hub });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pairing could not finish.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-web-client-gate className="flex min-h-screen items-center justify-center bg-app px-4 py-8 text-ink">
      <div className="w-full max-w-md rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/40 sm:p-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-secondary">V Bot · Web</div>
        <h1 className="mt-2 text-[22px] font-semibold tracking-tight">V Bot on the web</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Account sign-in discovers your systems. Hub pairing still requires a code, QR, or invitation from the hub.
        </p>

        {mode === "choose" && (
          <div className="mt-5 flex flex-col gap-2.5">
            <button
              type="button"
              className="rounded-xl bg-accent px-4 py-3 text-left text-[13px] font-semibold text-accent-ink transition hover:brightness-110"
              onClick={() => setMode("account")}
            >
              Sign in to find my systems
            </button>
            <button
              type="button"
              className="rounded-xl bg-control px-4 py-3 text-left text-[13px] font-medium text-ink transition hover:bg-raised"
              onClick={() => setMode("direct")}
            >
              Pair directly
            </button>
          </div>
        )}

        {mode === "account" && (
          <div className="mt-6 flex flex-col gap-4">
            {!session.account ? (
              <>
                <label className="flex flex-col gap-1.5 text-[13px]">
                  Email
                  <input
                    className="rounded-lg bg-inset px-3 py-2"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                  />
                </label>
                {otpSent && (
                  <label className="flex flex-col gap-1.5 text-[13px]">
                    Code
                    <input
                      className="rounded-lg bg-inset px-3 py-2 tracking-[0.2em]"
                      value={otp}
                      onChange={(event) => setOtp(event.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50"
                    onClick={() => void signInWithOtp()}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                    {otpSent ? "Verify code" : "Email me a code"}
                  </button>
                  {session.pocketIdEnabled && (
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-lg bg-control px-3 py-2 text-[13px] font-medium"
                      onClick={() => void signInWithPocketId()}
                    >
                      Sign in with PocketID
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="rounded-xl bg-inset px-3 py-3 text-[13px]">
                  Signed in as <span className="font-medium">{session.account.email}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {fleet.map((installation) => (
                    <button
                      key={installation.id}
                      type="button"
                      className={`rounded-xl border px-3 py-3 text-left text-[13px] ${
                        selectedHub?.id === installation.id ? "border-accent bg-accent/10" : "border-border bg-inset"
                      }`}
                      onClick={() => setSelectedHub(installation)}
                    >
                      <div className="font-medium">{installation.name}</div>
                      <div className="mt-1 flex items-center gap-2 text-ink-secondary">
                        <Wifi size={13} />
                        {installation.online ? "Online" : "Offline"}
                        {installation.endpoint?.status === "ready" ? " · Ready" : " · Needs setup"}
                      </div>
                    </button>
                  ))}
                  {!fleet.length && (
                    <p className="text-[13px] text-ink-secondary">No owned systems yet.</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink"
                    onClick={() => void pairSelectedHub()}
                  >
                    Continue to hub pairing
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-control px-3 py-2 text-[13px]"
                    onClick={() => {
                      clearAccountSession();
                      onSessionChange({ ...session, account: null, accountToken: null, fleet: [] });
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
            <button type="button" className="text-[12px] text-ink-secondary" onClick={() => setMode("choose")}>
              Back
            </button>
          </div>
        )}

        {mode === "direct" && (
          <div className="mt-6 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px]">
              Hub address
              <input
                className="rounded-lg bg-inset px-3 py-2"
                value={hubUrl}
                onChange={(event) => setHubUrl(event.target.value)}
                placeholder="https://your-hub.example"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              Pairing code or invitation
              <input
                className="rounded-lg bg-inset px-3 py-2"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]">
              Device name
              <input
                className="rounded-lg bg-inset px-3 py-2"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-50"
              onClick={() => void pairDirect()}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
              Pair this browser
            </button>
            <button type="button" className="text-[12px] text-ink-secondary" onClick={() => setMode("choose")}>
              Back
            </button>
          </div>
        )}

        {error && <p className="mt-4 text-[13px] text-danger">{error}</p>}
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
