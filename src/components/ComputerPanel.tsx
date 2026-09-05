// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll. macOS local mode keeps the legacy
// in-panel capture. Linux local mode is an automation readiness state and its
// separate preview remains explicitly user-initiated. Auto never selects a
// Linux user's desktop.
import { useEffect, useRef, useState } from "react";
import {
  ChevronsRight,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  Pause,
  Plus,
  Power,
  Settings,
  Smartphone,
} from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutineEditor } from "./RoutinesPage";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { ComputerControlButton } from "./ComputerControlButton";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { ShellHealth } from "./ShellHealth";
import { conversationTitle } from "@/lib/model-suffix";
import { DESKTOP_DEMO_SCREEN_DATA_URL, isDesktopDemoMode } from "@/lib/desktop-demo";
import { instanceSupportsLocalComputer, localComputerDisabledReason } from "@/lib/local-computer";
import { type VpsComputerStatus } from "@/lib/vps-computer";
import { computerStatusSummary } from "@/lib/computer-status";
import { useFleetVmLocation } from "./ComputerHostPicker";
import { ComputerActivityTimeline } from "./ComputerActivityTimeline";
import { vmPreviewCadenceMs } from "@/lib/vm-preview-cadence";
import {
  ComputerPaneStatus,
  computerPaneContext,
  computerPaneLifecycleNav,
  computerPaneLooksReady,
  localVmSettingsAction,
} from "./ComputerPaneStatus";

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

interface LocalVmStatus {
  mode: "shared" | "per-bot";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

import { isWebClientMode } from "@/lib/web-client-mode";
import { computerControlPath } from "@/lib/computer-control-path";

export function ComputerPanel({ bot, onExpandBrowser }: { bot: Bot; onExpandBrowser?: (botId: string) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [vmFrame, setVmFrame] = useState<string | null>(null);
  // Headless browser VM: the preview is a Chromium screenshot. Take control,
  // then click and type here. noVNC is for the BYO-VPS Cua desktop only.
  const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [panelView, setPanelView] = useState<"computer" | "android" | "browser">("computer");
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false && Boolean(window.ogb?.browser);
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const vmReadinessAttempts = useRef(0);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  const fleetVm = useFleetVmLocation();
  const fleetHostOnline = fleetVm.hostId && !fleetVm.selected ? false : fleetVm.selected?.online;
  const reconstructedEngine = selectedInstance?.driverKind === "grokReconstructed";
  const reconstructedComputerNotice =
    "Grok Reconstructed supports chat, roster, and transcript history only. Computer control, Local VM, attachments, queueing, and connected tools stay off for this engine.";
  const openNativeEnginePicker = () => {
    // The model picker in Bot settings is the single source of truth for
    // moving this bot back to the native V Bot/OpenMaus harness. Opening it
    // avoids silently changing a user's provider or model selection.
    dispatch({ type: "toggleSettings", open: true });
  };

  // Pause the screenshot poll while this bot's viewer is open; seed from the
  // live viewer so a remount/switch mid-session doesn't wrongly resume it.
  useEffect(() => {
    let alive = true;
    const dv = window.ogb?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    if (!androidConnected && panelView === "android") setPanelView("computer");
    if (!browserEnabled && panelView === "browser") setPanelView("computer");
  }, [androidConnected, browserEnabled, panelView]);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const cloudBackend = bot.cloudBackend ?? "box";
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      state.instances.some((instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available"),
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setVmFrame(null);
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    if (isDesktopDemoMode()) {
      setPhase("vm");
      setVmFrame(DESKTOP_DEMO_SCREEN_DATA_URL);
      return;
    }
    if (reconstructedEngine) {
      // Reconstructed has no MCP/computer integration. Do not even inspect
      // Box/VPS/Local VM state for Auto: doing so could provision a desktop
      // that this engine can never use and leaves a confusing blank panel.
      setPhase("error");
      return;
    }
    if (!vmSupported) {
      setError("This model engine cannot drive the Linux VM. Choose Claude or an ACP engine to control it.");
    }
    let retryTimer: number | undefined;
    api(`/api/bots/${bot.id}/local-computer`)
      .then((rawStatus) => {
        if (!alive) return;
        const status: LocalVmStatus = rawStatus;
        setVmStatus(status);
        const viewerUrl = String(status.viewer_url ?? "");
        if (viewerUrl.startsWith("http")) setVmViewerUrl(viewerUrl);
        const looksReady = computerPaneLooksReady({
          statusReady: status.ready,
          hostOnline: fleetHostOnline,
        });
        if (looksReady) {
          vmReadinessAttempts.current = 0;
          setError(null);
          setPhase("vm");
        } else if (
          status.container === "running" &&
          status.imageMatches &&
          status.managed &&
          status.network === "loopback" &&
          status.security === "hardened" &&
          status.persistence === "durable" &&
          !status.desktopReady &&
          fleetHostOnline !== false &&
          vmReadinessAttempts.current < 15
        ) {
          vmReadinessAttempts.current += 1;
          setError(null);
          setPhase("checking");
          retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
        } else {
          setError(status.problem && !fleetVm.blockReason ? status.problem : null);
          setPhase("vm-unavailable");
        }
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("vm-unavailable");
      });
    return () => {
      alive = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [
    bot.id,
    retry,
    reconstructedEngine,
    vmSupported,
    fleetVm.blockReason,
    fleetVm.hostId,
    fleetHostOnline,
  ]);

  // cloud preview: SSE frames win while the bot works; otherwise poll.
  // Every preview poll below gates on visibility and slows way down for an
  // idle bot — a drawer left open overnight must not keep shooting.
  const pageVisible = usePageVisible();
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (isDesktopDemoMode()) return;
    if (phase !== "ready" || sseFlowing || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, bot.busy ? 4000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, sseFlowing, bot.id, viewerOpen, pageVisible, bot.busy]);

  // Local VM preview comes directly from Chromium CDP through the selected
  // bridge. While the person holds control, keep it visually live; otherwise
  // retain the low-cost heartbeat cadence.
  const humanHoldingVm = state.computerControl[bot.id]?.held === true;
  const vmInFlight = useRef(false);
  useEffect(() => {
    if (isDesktopDemoMode()) return;
    if (phase !== "vm" || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (vmInFlight.current) return;
      vmInFlight.current = true;
      try {
        const { image } = await api(`/api/bots/${bot.id}/local-computer/screenshot`, { method: "POST", body: "{}" });
        if (alive && typeof image === "string") setVmFrame(image);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        vmInFlight.current = false;
      }
    };
    void shoot();
    const timer = window.setInterval(
      () => void shoot(),
      vmPreviewCadenceMs({ humanHeld: humanHoldingVm, botBusy: bot.busy === true }),
    );
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, bot.id, viewerOpen, pageVisible, bot.busy, humanHoldingVm]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.ogb || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    // A real ScreenCaptureKit capture + PNG encode per tick: idle bots get a
    // slow heartbeat, working ones the live cadence.
    const timer = setInterval(shoot, bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, isLinux, pageVisible, bot.busy]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(frameSrc && phase === "ready");
  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const controlPath = computerControlPath(bot.id, bot.computer, isWebClientMode());
  const drivingBrowser = Boolean(controlPath) && phase === "vm" && control.held && Boolean(frameSrc);
  useEffect(() => {
    let alive = true;
    if (!controlPath) return;
    api(controlPath)
      .then((snap) => {
        if (!alive) return;
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: typeof snap.helpReason === "string" ? snap.helpReason : null,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, controlPath]);
  const requestControl = async (action: "take" | "release" | "dismiss-help") => {
    if (!controlPath) throw new Error("Only this bot's Local VM is controllable from the paired web client.");
    const snap = await api(controlPath, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: typeof snap.helpReason === "string" ? snap.helpReason : null,
    });
    return snap;
  };

  const controlAction = (action: "take" | "release" | "dismiss-help") => {
    setControlPending(true);
    requestControl(action)
      .catch((e) => setError(e.message))
      .finally(() => setControlPending(false));
  };

  const sendBrowserInput = async (body: Record<string, unknown>) => {
    await api(`/api/bots/${bot.id}/local-computer/input`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  };

  const onBrowserPreviewClick = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!drivingBrowser) return;
    const img = event.currentTarget;
    const rect = img.getBoundingClientRect();
    if (!img.naturalWidth || !rect.width || !rect.height) return;
    const x = Math.round(((event.clientX - rect.left) / rect.width) * img.naturalWidth);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * img.naturalHeight);
    try {
      await sendBrowserInput({
        action: "click",
        x,
        y,
        button: event.button === 2 ? "right" : "left",
        double: event.detail === 2,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const onBrowserPreviewKey = async (event: React.KeyboardEvent<HTMLImageElement>) => {
    if (!drivingBrowser) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    try {
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        await sendBrowserInput({ action: "type", text: event.key });
        return;
      }
      const parts = [
        event.ctrlKey || event.metaKey ? "ctrl" : "",
        event.altKey ? "alt" : "",
        event.shiftKey && event.key.length > 1 ? "shift" : "",
        event.key === "Enter" ? "Return" : event.key,
      ].filter(Boolean);
      await sendBrowserInput({ action: "key", keys: parts.join("+") });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const openDesktop = async () => {
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    // A plain-web development session still needs a synchronous blank tab;
    // the packaged app uses the reliable Electron viewer window below.
    let fallbackTab: Window | null = null;
    if (!window.ogb?.desktopViewer && !window.ogb?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await requestControl("take");
        tookControl = true;
      }

      let viewerUrl = vmViewerUrl;
      if (phase === "ready") {
        const result = await api(`/api/bots/${bot.id}/computer/join`, { method: "POST" });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!viewerUrl) throw new Error("The computer did not return a live desktop link");

      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, `${bot.name}'s live desktop`, bot.id);
        if (!opened) throw new Error("V Bot could not open the live desktop");
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.ogb?.openExternal) {
        const opened = await window.ogb.openExternal(viewerUrl);
        if (!opened) throw new Error("V Bot could not open the live desktop link");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new Error("Your browser blocked the live desktop tab");
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the bot before waiting on best-effort tunnel cleanup. A sick
      // SSH process must never leave the agent paused indefinitely.
      if (tookControl) await requestControl("release").catch(() => {});
      if (phase === "ready" && cloudBackend === "vps") {
        await api(`/api/bots/${bot.id}/computer/viewer-close`, { method: "POST", body: "{}" }).catch(() => {});
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setControlPending(false);
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        if (kind === "provision") {
          setBoxState(result.container ?? null);
          if (result.ready) setPhase("ready");
          else {
            setError(result.problem ?? "The VPS Cua desktop is not ready yet");
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setBoxState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
        }
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => setPending(null));
  };

  const replaceVpsComputer = async () => {
    if (!window.confirm(`Replace ${bot.name}'s VPS computer with the version required by this V Bot update? Files stored only inside the disposable container will be deleted.`)) return;
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      setVpsStatus(result);
      setBoxState(result.container ?? null);
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError(result.problem ?? "The replacement VPS Cua desktop is not ready yet");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const openVmSettings = () => {
    dispatch(localVmSettingsAction());
  };

  const openConnectionSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  const emptyState = {
    checking: "Checking…",
    starting: "Starting your bot's computer…",
    unconfigured: "No cloud computer configured",
    "vps-unconfigured": "No managed VPS computer is configured for this bot",
    "vps-incompatible": "This VPS computer belongs to an earlier V Bot version",
    "vps-stopped": "The managed VPS computer is stopped",
    "local-unavailable": reconstructedEngine ? reconstructedComputerNotice : localDisabledReason ?? "Local computer control isn't ready.",
    "vm-unavailable": reconstructedEngine ? reconstructedComputerNotice : "The browser isn't available for this bot",
    off: "This bot's computer is off",
    error: reconstructedEngine ? reconstructedComputerNotice : "Couldn't reach the computer",
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;
  const isolation = vmStatus?.mode ?? state.config?.localVm.mode ?? null;
  const paneContext = computerPaneContext({
    host: fleetVm.selected ?? null,
    isolation,
  });
  const statusSummary = computerStatusSummary({
    phase,
    cloudBackend,
    linux: isLinux,
    reconstructed: reconstructedEngine,
    error,
    shared: isolation !== "per-bot",
    hostName: paneContext.hostName || null,
    hostOnline: fleetHostOnline,
  });
  const lifecycle = computerPaneLifecycleNav({
    container: vmStatus?.container,
    ready: phase === "vm",
  });

  return (
    <>
    <aside className="shell-right animate-panel-in flex h-full flex-col border-l border-hairline/30 bg-panel">
      {/* Header */}
      <div className="shell-header justify-between gap-2 px-3">
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="shell-icon-btn text-ink-secondary hover:bg-control hover:text-ink"
          aria-label="Bot settings"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        {androidConnected || browserEnabled ? (
          <div className="flex min-w-0 overflow-hidden rounded-lg border border-hairline/40">
            <button
              onClick={() => setPanelView("computer")}
              aria-pressed={panelView === "computer"}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]",
                panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Monitor size={13} /> Computer
            </button>
            {browserEnabled && (
              <button
                onClick={() => setPanelView("browser")}
                aria-pressed={panelView === "browser"}
                className={cn(
                  "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                  panelView === "browser" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                <Globe size={13} /> Browser
              </button>
            )}
            {androidConnected && (
              <button
                onClick={() => setPanelView("android")}
                aria-pressed={panelView === "android"}
                className={cn(
                  "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                  panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                <Smartphone size={13} /> Android
              </button>
            )}
          </div>
        ) : (
          <span className="text-[15px] font-semibold text-ink">Computer</span>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="shell-icon-btn text-ink-secondary hover:bg-control hover:text-ink"
          aria-label="Collapse right rail"
          title="Collapse right rail"
        >
          <ChevronsRight size={18} />
        </button>
      </div>

      {panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-3">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : panelView === "browser" && browserEnabled ? (
        <div className="min-h-0 flex-1">
          <BrowserPanel
            bot={bot}
            control={control}
            controlPending={controlPending}
            onExpand={onExpandBrowser ? () => onExpandBrowser(bot.id) : undefined}
            onControl={async (action) => {
              const snap = await requestControl(action);
              return snap.held === (action === "take");
            }}
          />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3">
          <div data-computer-status={phase}>
            <ComputerPaneStatus
              context={paneContext}
              summary={statusSummary}
              lifecycle={lifecycle}
              onOpenSettings={openVmSettings}
            />
          </div>
          {/* Screen preview */}
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg bg-card">
          {frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={`Open ${bot.name}'s live desktop`}
              title="Open live desktop"
            >
              <img
                src={frameSrc}
                alt={`${bot.name}'s screen`}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                Open
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={`${bot.name}'s screen`}
              className={cn("h-full w-full object-contain", drivingBrowser && "cursor-crosshair")}
              title={drivingBrowser ? "You have the wheel — click and type here" : phase === "vm" ? "Watch-only preview" : undefined}
              tabIndex={drivingBrowser ? 0 : undefined}
              onClick={drivingBrowser ? (event) => void onBrowserPreviewClick(event) : undefined}
              onContextMenu={drivingBrowser ? (event) => { event.preventDefault(); void onBrowserPreviewClick(event); } : undefined}
              onKeyDown={drivingBrowser ? (event) => void onBrowserPreviewKey(event) : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "vm"
                    ? "Capturing the browser screen…"
                  : phase === "local"
                    ? isLinux
                      ? "Ready for approved bot actions. Start the separate preview below when you want to watch the screen."
                      : localMisses >= 3
                      ? "No frames yet: the preview needs Screen Recording permission. After granting, relaunch the app."
                      : "Capturing this computer's screen…"
                    : emptyState[phase]}
              </span>
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  type="button"
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="shell-pane-btn mt-1 bg-control text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
              {(phase === "vps-unconfigured" || phase === "vps-stopped") && !reconstructedEngine && (
                <button
                  type="button"
                  onClick={openConnectionSettings}
                  className="shell-pane-btn mt-1 bg-control text-ink hover:bg-raised-hover"
                >
                  Open VPS settings
                </button>
              )}
              {(phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) && !reconstructedEngine &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  type="button"
                  onClick={() => run("provision")}
                  disabled={pending === "provision"}
                  className="shell-pane-btn mt-1 bg-control text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="animate-spin" />}
                  {phase === "vps-stopped" ? "Start VPS computer" : "Prepare VPS computer"}
                </button>
              )}
              {phase === "vps-incompatible" && !reconstructedEngine && vpsStatus?.managed &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  type="button"
                  onClick={() => void replaceVpsComputer()}
                  disabled={pending === "vps-replace"}
                  className="shell-pane-btn mt-1 bg-accent font-medium hover:brightness-110 disabled:opacity-50"
                >
                  {pending === "vps-replace" && <Loader2 size={13} className="animate-spin" />}
                  Replace VPS computer
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-1.5 mb-2 text-[12.5px] text-ink-secondary">
          {conversationTitle(bot.name, bot.modelSelection)}'s screen
        </div>
        <ComputerActivityTimeline
          threadId={bot.threadId}
          busy={bot.busy === true}
          held={control.held}
          helpReason={control.helpReason}
        />
        <ShellHealth bot={bot} />

        {reconstructedEngine && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-3">
            <div className="text-[12px] leading-relaxed text-warning">{reconstructedComputerNotice}</div>
            <button
              type="button"
              onClick={openNativeEnginePicker}
              className="shell-pane-btn mt-2 bg-control font-medium text-ink hover:bg-raised-hover"
            >
              Choose Vi Bot engine
            </button>
          </div>
        )}

        <div className="mt-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[14px] font-semibold text-ink">Routines</div>
            <button
              type="button"
              onClick={() => setCreatingRoutine(true)}
              className="shell-icon-btn text-ink-secondary hover:bg-control hover:text-ink"
              aria-label={`Add a routine for ${bot.name}`}
              title="Add routine"
            >
              <Plus size={18} />
            </button>
          </div>
          {activeRoutineRun && (
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[12px] text-accent hover:bg-raised/50"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-0.5">
              {botRoutines.map((routine) => (
                <button
                  key={routine.id}
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-raised/40"
                >
                  <Pause size={14} className="shrink-0 text-ink-secondary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[11px] text-ink-secondary">
                      {routine.enabled ? nextRunLabel(routine.nextRunAt) : "Paused"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Add a Box API key to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {phase === "vps-unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Configure the VPS SSH alias in App Settings → Connections. Auto only reuses an existing ready container.
            </div>
            <button
              type="button"
              onClick={openConnectionSettings}
              className="shell-pane-btn bg-control text-ink hover:bg-raised-hover"
            >
              Open VPS settings
            </button>
          </div>
        )}

        {/* Who is driving — take the wheel / hand it back */}
        {(phase === "ready" || phase === "vm") && controlPath && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4">
            <div className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> asked for your hands: {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "ready" ? void openDesktop() : controlAction("take")
                }
                disabled={controlPending || pending === "join"}
                className="shell-pane-btn flex-1 bg-accent font-medium hover:brightness-110 disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                Take control
              </button>
              <button
                onClick={() => controlAction("dismiss-help")}
                disabled={controlPending}
                className="shell-pane-btn bg-control text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {(phase === "ready" || phase === "vm") && controlPath && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              You have the wheel. The bot takes no clicks or keystrokes until you hand it back.
              {phase === "ready" && " Use Open desktop to drive."}
              {phase === "vm" && " Click the preview to drive the browser. Type while it is focused."}
            </div>
            <button
              onClick={() => {
                controlAction("release");
                void window.ogb?.desktopViewer?.close(bot.id);
              }}
              disabled={controlPending}
              className="shell-pane-btn mt-2 w-full bg-accent font-medium hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              Hand control back
            </button>
          </div>
        )}
        {(phase === "vm" || (phase === "ready" && !controlPath)) && !isDesktopDemoMode() && (!controlPath || (!control.held && !control.helpReason)) && (
          <ComputerControlButton
            canControl={Boolean(controlPath)}
            pending={controlPending || pending === "join"}
            onTake={() => controlAction("take")}
            onConfigure={() => dispatch({ type: "toggleSettings", open: true })}
          />
        )}
        {/* Cloud-only actions */}
        {phase === "ready" && controlPath && (
          <div className="mt-3 flex gap-2">
            {!control.held && !control.helpReason && (
              <button
                onClick={() =>
                  void openDesktop()
                }
                disabled={controlPending || pending === "join"}
                className="shell-pane-btn flex-1 bg-control text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Pause the bot's hands and drive this computer yourself"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                Take control
              </button>
            )}
            {control.held && (
              <button
                onClick={() => void openDesktop()}
                disabled={pending === "join"}
                className="shell-pane-btn flex-1 bg-control text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                Open live desktop
              </button>
            )}
            {(cloudBackend === "vps" || boxState !== "archived") && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="shell-pane-btn flex-1 bg-control text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}

        {!reconstructedEngine && <LocalScreenPreview />}
        {!reconstructedEngine && <LinuxLocalControl />}
        {!reconstructedEngine && <MacLocalControl />}
      </div>
      )}
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          defaultRunOn={cloudRoutineReady ? "cloud" : "maus"}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
    </>
  );
}
