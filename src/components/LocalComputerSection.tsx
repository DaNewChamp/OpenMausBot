// One-place setup for the isolated Local VM image and its shared/per-bot policy.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Card, CommandLine } from "./SettingsPrimitives";
import { isWebClientMode } from "@/lib/web-client-mode";
import { cn } from "@/lib/cn";
import { api, useStore } from "@/state/store";
import { FleetVmLocationPicker, useFleetVmLocation } from "./ComputerHostPicker";

import { localVmSettingsBotId, localVmSettingsActionPath, localVmContainerExists, type LocalVmSettingsAction } from "@/lib/local-vm-settings";

type Action = LocalVmSettingsAction;

interface Status {
  // The companion deliberately projects a safe status rather than host paths.
  daemon_up?: boolean;
  image_ready?: boolean;
  desktop_ready?: boolean;
  can_create?: boolean;
  can_stop?: boolean;
  can_recreate?: boolean;
  busy?: boolean;
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  mode: "shared" | "per-bot";
  max_instances: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px] leading-snug", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2.5 flex flex-col items-start gap-2.5">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
  disabled = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending !== null || disabled}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function LocalComputerSection() {
  const { state } = useStore();
  const pairedClient = isWebClientMode();
  const fleetVm = useFleetVmLocation();
  const [status, setStatus] = useState<Status | null>(null);
  const [explicitBotId, setExplicitBotId] = useState<string | undefined>();
  const mode = status?.mode ?? state.config?.localVm.mode ?? "shared";
  const botId = localVmSettingsBotId({ bots: state.bots, selectedId: state.selectedId, explicitBotId, mode });
  const targetBot = state.bots.find((bot) => bot.id === botId);
  const responseVersion = useRef(0);
  useEffect(() => setExplicitBotId(undefined), [state.selectedId]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    const version = ++responseVersion.current;
    if (pairedClient && !botId) {
      setStatus(null);
      setError(null);
      return;
    }
    const path = botId ? `/api/bots/${botId}/local-computer` : "/api/local-computer";
    const body = await api(path);
    if (version !== responseVersion.current) return;
    setStatus(body as Status);
    setError(null);
  }, [botId, pairedClient]);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setLoading(true);
    let timer: number | undefined;
    const poll = async () => {
      try {
        await refresh();
      } catch (e) {
        if (active) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      responseVersion.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  const post = async (action: Action) => {
    const path = localVmSettingsActionPath({ botId, mode, action, pairedClient });
    const version = ++responseVersion.current;
    const body = await api(path, { method: "POST", body: "{}" });
    if (version === responseVersion.current) setStatus(body as Status);
  };

  const act = async (action: Action) => {
    if (mode === "per-bot" && action !== "pull" && (!targetBot || targetBot.busy)) {
      setError(targetBot?.busy ? "Stop this bot's turn before managing its browser." : "Choose a bot first.");
      return;
    }
    if (
      action === "remove" &&
      !window.confirm(`Delete ${mode === "per-bot" ? `${targetBot?.name ?? "this bot"}'s` : "the shared"} browser container? Its durable files and browser sign-ins will remain.`)
    ) return;
    if (
      action === "recreate" &&
      !window.confirm("Replace the existing Local VM with the pinned image and safety limits? Files and browser sign-ins in its durable workspace will remain.")
    ) return;
    setPending(action);
    setError(null);
    try {
      // Keep replacement atomic under the hub's existing lifecycle guard.
      await post(action);
      // The desktop starts after the container process; keep the progress
      // state honest and let the regular poll mark it Ready a few seconds on.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const savePolicy = async (mode: Status["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setError(null);
    try {
      await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = localVmContainerExists(status);
  const needsRecreate = Boolean(
    existing &&
      (status?.container === "stopped" ||
        !status?.imageMatches ||
        !status?.managed ||
        status?.network === "unsafe" ||
        status?.security === "unsafe" ||
        status?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const perBot = mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && status?.runtime === "container";
  const headerReady = ready && fleetVm.selected?.online !== false && (!perBot || Boolean(targetBot));
  const statusLabel = loading
    ? "Checking…"
    : perBot && !targetBot
      ? "Choose a bot"
      : fleetVm.selected?.online === false
        ? "Machine offline"
        : unavailable
      ? "Status unavailable"
      : perBot && headerReady
        ? "Ready for per-bot desktops"
        : perBotRuntimeUnsupported
          ? "Needs Docker or Podman"
          : ready
            ? "Ready"
            : "Not ready";
  const problemText =
    !loading && !unavailable && !headerReady && status?.problem && status.problem !== statusLabel
      ? status.problem
      : null;

  // The web app uses the companion contract, not desktop-only commands or
  // broad configuration writes. Keep that distinction visible and actionable.
  if (pairedClient) {
    const busy = status?.busy === true || targetBot?.busy === true;
    const blocked = loading || pending !== null || busy || Boolean(fleetVm.blockReason) || !botId;
    return (
      <>
        <Card title="Browser location" subtitle="Run Chromium on a paired machine while V Bot stays connected to your hub.">
          <div className="flex flex-col gap-3">
            <FleetVmLocationPicker hosts={fleetVm.hosts} value={fleetVm.hostId}
              disabled={pending !== null || busy}
              onChange={(hostId) => {
                void fleetVm.save(hostId).then(() => setRefreshKey((key) => key + 1)).catch((e) => {
                  setError(e instanceof Error ? e.message : String(e));
                });
              }} />
            {fleetVm.blockReason && <p className="text-[12.5px] text-warning">{fleetVm.blockReason}</p>}
            {perBot && (
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-secondary">
                Bot workspace
                <select aria-label="Bot workspace" value={botId ?? ""} disabled={pending !== null}
                  onChange={(event) => setExplicitBotId(event.target.value)}
                  className="rounded-lg border border-hairline/40 bg-control px-3 py-2 text-ink">
                  <option value="">Choose a bot</option>
                  {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </Card>
        <Card title={perBot ? "Private browser" : "Shared browser"}
          subtitle={perBot ? "This bot has its own Chromium container and durable workspace." : "Bots take turns in one Chromium container and share its browser profile and workspace."}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[13px]">
              {loading ? <Loader2 size={14} className="animate-spin" /> : headerReady ? <Check size={14} className="text-success" /> : <Circle size={10} />}
              <span>{!botId ? "Choose a bot" : statusLabel}</span>
              <button type="button" disabled={loading || pending !== null}
                onClick={() => { setLoading(true); setRefreshKey((key) => key + 1); }}
                className="shell-pane-btn ml-auto text-ink-secondary hover:bg-control">
                <RefreshCw size={13} /> Re-check
              </button>
            </div>
            {!botId && <p className="text-[13px] text-ink-secondary">Choose a bot above to manage its private browser.</p>}
            {status?.problem && !ready && <p className="text-[13px] leading-relaxed text-warning">{status.problem}</p>}
            {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[13px] text-danger">{error}</p>}
            {busy && <p className="text-[12.5px] text-ink-secondary">A bot is using this browser. Stop its turn before changing the container.</p>}
            <div className="flex flex-wrap gap-2">
              {status?.can_create && <ActionButton action="run" pending={pending} disabled={blocked} onClick={() => void act("run")}>Deploy browser</ActionButton>}
              {status?.can_stop && <ActionButton action="stop" pending={pending} disabled={blocked} onClick={() => void act("stop")}><Square size={12} /> Stop</ActionButton>}
              {!ready && status?.can_recreate && <ActionButton action="recreate" pending={pending} disabled={blocked} onClick={() => void act("recreate")}><RotateCcw size={12} /> Recreate browser</ActionButton>}
            </div>
            <p className="text-[12px] leading-relaxed text-ink-secondary">Use the Computer pane to watch the screen and take control. Browser files in the durable workspace survive container replacement.</p>
          </div>
        </Card>
        <Card title="Host-managed settings" subtitle="Image preparation, shared/private isolation policy, capacity limits, and container deletion stay in desktop Settings. This paired web client does not expose the host's administrative configuration." />
      </>
    );
  }

  return (
    <>
      <Card
        title="Browser location"
        subtitle="Choose a connected machine for the Chromium container. Shared and private workspaces are managed here."
      >
        <div className="flex flex-col gap-3">
          <FleetVmLocationPicker
            hosts={fleetVm.hosts}
            value={fleetVm.hostId}
            disabled={policyPending || pending !== null}
            onChange={(hostId) => {
              void fleetVm.save(hostId).then(() => setRefreshKey((key) => key + 1)).catch((e) => {
                setError(e instanceof Error ? e.message : String(e));
              });
            }}
          />
          <div className="text-[12px] leading-relaxed text-ink-secondary">
            {fleetVm.blockReason
              ?? (perBot
                ? "Each bot gets its own container on that machine."
                : "Bots take turns driving one shared desktop on that machine.")}
          </div>
          {perBot && (
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-secondary">
              Bot workspace
              <select
                aria-label="Bot workspace"
                value={botId ?? ""}
                disabled={pending !== null}
                onChange={(event) => setExplicitBotId(event.target.value)}
                className="rounded-lg border border-hairline/40 bg-control px-3 py-2 text-ink"
              >
                <option value="">Choose a bot</option>
                {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
              {targetBot?.busy && <span>Stop this bot's turn before managing its browser.</span>}
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (fleetVm.blockReason) {
                  setError(fleetVm.blockReason);
                  return;
                }
                if (!botId) {
                  setError("Create a bot first, then Deploy.");
                  return;
                }
                void (async () => {
                  try {
                    if (fleetVm.selectedId && fleetVm.selectedId !== fleetVm.hostId) {
                      await fleetVm.save(fleetVm.selectedId);
                    }
                    await act("run");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  }
                })();
              }}
              disabled={pending !== null || Boolean(fleetVm.blockReason) || !botId || (perBot && Boolean(targetBot?.busy))}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              {pending === "run" && <Loader2 size={13} className="animate-spin" />}
              Deploy
            </button>
          </div>
        </div>
      </Card>

      <Card
        title="Local VM"
        subtitle={perBot
          ? `Private headless Chromium + shell containers on the selected fleet machine, with one container and durable workspace per bot. Distinct bots can work concurrently and idle VMs stop after 8 hours.`
          : `A shared headless Chromium + shell sandbox on the selected fleet machine: isolated, backed by one durable workspace, and automatically recycled after 8 hours without activity.`}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
                headerReady ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
              )}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : headerReady ? <Check size={12} /> : <Circle size={9} />}
              {statusLabel}
            </span>
            <button
              onClick={() => {
                setLoading(true);
                setRefreshKey((key) => key + 1);
              }}
              disabled={loading || pending !== null}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
            >
              <RefreshCw size={12} /> Re-check
            </button>
            {ready && !perBot && status?.viewer_url?.startsWith("http") && (
              <a
                href={status.viewer_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-control"
              >
                <ExternalLink size={12} /> Watch screen
              </a>
            )}
          </div>
          {problemText && (
            <div className="rounded-lg bg-warning/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-warning">
              {problemText}
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
              {error}
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Isolation"
        subtitle="Shared keeps one browser VM for every bot. Per bot gives each bot its own container, workspace, debugger port, lease, and idle timer."
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {(["shared", "per-bot"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              disabled={!status || policyPending}
              onClick={() => void savePolicy(mode, status?.max_instances ?? 2)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                status?.mode === mode ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {mode === "shared" ? "Shared" : "Per bot"}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] text-ink">Maximum per-bot desktops</div>
            <div className="text-[11.5px] text-ink-secondary">Limits storage and host resource use; each running browser VM may use up to 1 GB and 1 CPU.</div>
          </div>
          <select
            aria-label="Maximum per-bot desktops"
            value={status?.max_instances ?? 2}
            disabled={!status || policyPending}
            onChange={(event) => void savePolicy(status?.mode ?? "shared", Number(event.target.value))}
            className="rounded-lg border border-hairline/40 bg-control px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        {policyPending && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" /> Saving…</div>}
      </Card>

      <Card title="Setup" subtitle="Once a container runtime is open, Vi Bot prepares the browser VM for you.">
        <div className="flex flex-col gap-5">
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? `Open and start ${status.runtime}` : "Start the container runtime"}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
            )}
          </Step>

          <Step n={3} title="Prepare the browser VM (one-time download and build)" done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare browser VM</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show base-image download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={needsRecreate ? "Replace the older or unsafe container" : "Create and start the browser container"}
            done={headerReady}
          >
            {perBot && !targetBot ? (
              <div className="text-[13px] text-ink-secondary">Choose a bot above to manage its private browser.</div>
            ) : perBotRuntimeUnsupported ? (
              <div className="text-[13px] text-ink-secondary">This runtime cannot allocate private loopback ports. Use Docker or Podman for per-bot containers.</div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{status?.problem}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> Delete and recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the browser VM image above before replacing this VM.</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>Start Local VM</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Waiting for Chromium…</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>Create Local VM</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>Vi Bot could not inspect the container runtime. Re-check, or review the app logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="Safety and storage"
        subtitle={perBot
          ? `Each bot gets a private host folder mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; git checkouts and the Chromium profile survive VM replacement. The debugger binds only to loopback, and exact bot-derived targets prevent one bot from attaching to another bot's container. Each VM is limited to 1 GB, 1 CPU, 256 processes, and dropped capabilities. VMs can still reach the internet.`
          : `Exactly one private host folder is mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; files and browser sign-ins there survive VM replacement, while everything elsewhere in the VM remains disposable. Drive the browser from the Computer pane. Docker and Podman runs are limited to 1 GB memory, 1 CPU and 256 processes; all Linux capabilities are dropped except the two needed to switch to the unprivileged user. The VM can still reach the internet, and bots share it one at a time.`}
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} disabled={perBot && (!targetBot || targetBot.busy)} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} disabled={perBot && (!targetBot || targetBot.busy)} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? "Delete this bot's browser" : "Delete shared browser"}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          Durable workspace: {status?.workspace_path ?? "not created"} ·{" "}
          Browser image: {status?.image_ref ?? "not prepared"}
          {status?.base_image_ref ? <> · Base: {status.base_image_ref}</> : null}
        </div>
      </Card>
    </>
  );
}
