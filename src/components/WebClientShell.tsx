import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Loader2,
  LogOut,
  Mail,
  Menu,
  MonitorSmartphone,
  Settings,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { ChatView } from "@/components/ChatView";
import { GroupView } from "@/components/GroupView";
import { PluginsPanel, preloadConnectedApps } from "@/components/PluginsPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar } from "@/components/Sidebar";
import { StoreProvider, useStore, type Bot as BotRecord } from "@/state/store";
import {
  canCallHubApi,
  clearAccountSession,
  clearHubConnection,
  completeWebAuthHandoff,
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

export type WebClientNav = "conversations" | "bots" | "fleet" | "settings" | "approvals";

function openApprovalBots(bots: BotRecord[]): BotRecord[] {
  return bots.filter((bot) =>
    bot.messages.some(
      (message) =>
        message.kind === "options" &&
        message.card?.requestId &&
        !message.card.answered &&
        !message.card.dismissed,
    ),
  );
}

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
  const [hubUrl, setHubUrl] = useState("");
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
    <div className="flex min-h-screen items-center justify-center bg-app px-4 py-10 text-ink">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-raised p-6 shadow-lg">
        <h1 className="text-[22px] font-semibold">V Bot on the web</h1>
        <p className="mt-2 text-[14px] text-ink-secondary">
          Account sign-in discovers your systems. Hub pairing still requires a code, QR, or invitation from the hub.
        </p>

        {mode === "choose" && (
          <div className="mt-6 flex flex-col gap-3">
            <button
              type="button"
              className="rounded-xl bg-accent px-4 py-3 text-left text-[14px] font-medium text-accent-ink"
              onClick={() => setMode("account")}
            >
              Sign in to find my systems
            </button>
            <button
              type="button"
              className="rounded-xl bg-control px-4 py-3 text-left text-[14px] font-medium text-ink"
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

function WebClientNavButton({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Bot;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${
        active ? "bg-accent text-accent-ink" : "text-ink-secondary hover:bg-control hover:text-ink"
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

export function WebClientShell() {
  const { state, dispatch } = useStore();
  const [nav, setNav] = useState<WebClientNav>("conversations");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const group = state.groups.find((entry) => entry.id === state.selectedId);
  const bot = group ? undefined : (state.bots.find((entry) => entry.id === state.selectedId) ?? state.bots[0]);
  const approvalBots = useMemo(() => openApprovalBots(state.bots), [state.bots]);

  useEffect(() => {
    if (canCallHubApi()) void preloadConnectedApps();
  }, []);

  const signOutHub = () => {
    clearHubConnection();
    globalThis.location.reload();
  };

  return (
    <div className="flex h-screen bg-app text-ink">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-raised p-4 transition-transform md:static md:translate-x-0 ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[15px] font-semibold">V Bot</div>
          <button type="button" className="md:hidden" onClick={() => setDrawerOpen(false)} aria-label="Close menu">
            <X size={16} />
          </button>
        </div>
        <nav className="flex flex-col gap-1">
          <WebClientNavButton active={nav === "conversations"} label="Conversations" icon={Users} onClick={() => setNav("conversations")} />
          <WebClientNavButton active={nav === "bots"} label="Bots" icon={Bot} onClick={() => setNav("bots")} />
          <WebClientNavButton active={nav === "fleet"} label="Fleet" icon={MonitorSmartphone} onClick={() => setNav("fleet")} />
          <WebClientNavButton active={nav === "settings"} label="Settings" icon={Settings} onClick={() => setNav("settings")} />
          <WebClientNavButton active={nav === "approvals"} label="Approvals" icon={CheckCircle2} onClick={() => setNav("approvals")} />
        </nav>
        <button
          type="button"
          className="mt-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
          onClick={signOutHub}
        >
          <LogOut size={15} />
          Unpair browser
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:hidden">
          <button type="button" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <div className="text-[14px] font-medium capitalize">{nav}</div>
        </header>

        {nav === "conversations" && (
          <div className="flex min-h-0 flex-1">
            <div className="hidden w-72 border-r border-border md:block">
              <Sidebar open onClose={() => setDrawerOpen(false)} />
            </div>
            <div className="min-w-0 flex-1">
              {group ? <GroupView key={group.id} group={group} /> : bot ? <ChatView bot={bot} /> : (
                <div className="flex h-full items-center justify-center text-ink-secondary">Select a conversation</div>
              )}
            </div>
          </div>
        )}

        {nav === "bots" && (
          <div className="grid gap-3 overflow-auto p-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.bots.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="rounded-xl border border-border bg-raised px-4 py-4 text-left"
                onClick={() => {
                  dispatch({ type: "select", id: entry.id });
                  setNav("conversations");
                }}
              >
                <div className="font-medium">{entry.name}</div>
                <div className="mt-1 text-[12px] text-ink-secondary">{entry.title || "Bot"}</div>
              </button>
            ))}
          </div>
        )}

        {nav === "fleet" && (
          <div className="space-y-3 overflow-auto p-4">
            <div className="rounded-xl border border-border bg-raised px-4 py-4 text-[13px]">
              <div className="font-medium">This browser</div>
              <div className="mt-1 text-ink-secondary">Paired to the selected hub with a device token.</div>
            </div>
            {state.bots.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-border bg-raised px-4 py-4 text-[13px]">
                <div className="font-medium">{entry.name}</div>
                <div className="mt-1 text-ink-secondary">
                  {entry.busy ? "Running" : "Idle"} · {entry.computer ?? "off"} computer
                </div>
              </div>
            ))}
          </div>
        )}

        {nav === "settings" && bot && (
          <div className="overflow-auto p-4">
            <SettingsPanel bot={bot} />
            <button
              type="button"
              className="mt-4 rounded-lg bg-control px-3 py-2 text-[13px]"
              onClick={() => dispatch({ type: "togglePlugins", open: true })}
            >
              Connected apps
            </button>
          </div>
        )}

        {nav === "settings" && !bot && (
          <div className="flex h-full items-center justify-center text-ink-secondary">Choose a bot to edit settings.</div>
        )}

        {nav === "approvals" && (
          <div className="space-y-3 overflow-auto p-4">
            {approvalBots.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="block w-full rounded-xl border border-border bg-raised px-4 py-4 text-left text-[13px]"
                onClick={() => {
                  dispatch({ type: "select", id: entry.id });
                  setNav("conversations");
                }}
              >
                <div className="font-medium">{entry.name}</div>
                <div className="mt-1 text-ink-secondary">Needs approval in chat</div>
              </button>
            ))}
            {!approvalBots.length && (
              <div className="rounded-xl border border-border bg-raised px-4 py-8 text-center text-[13px] text-ink-secondary">
                No open approvals.
              </div>
            )}
          </div>
        )}
      </div>

      {state.pluginsOpen && <PluginsPanel />}
    </div>
  );
}

export function WebClientApp() {
  const [session, setSession] = useState(() => loadWebClientSession());

  if (!canCallHubApi()) {
    return <WebClientGate session={session} onSessionChange={setSession} />;
  }
  return (
    <StoreProvider>
      <WebClientShell />
    </StoreProvider>
  );
}

export default WebClientApp;
