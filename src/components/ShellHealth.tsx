import { Cable, ChevronDown, KeyRound, QrCode, Server } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import { isDesktopDemoMode } from "@/lib/desktop-demo";
import { bridgeHealth, computerEngineBadge } from "@/lib/shell-status";
import { useStore, type Bot } from "@/state/store";
import { companionBridge } from "./PhoneSetupFlow";

export function ShellHealth({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const demo = isDesktopDemoMode();
  const [open, setOpen] = useState(false);
  const [pairLive, setPairLive] = useState<{ enabled: boolean; paired: number; live: number } | null>(
    demo ? { enabled: true, paired: 1, live: 1 } : null,
  );

  useEffect(() => {
    if (demo) return;
    const bridge = companionBridge();
    if (!bridge) return;
    let alive = true;
    const read = () => {
      void bridge
        .state()
        .then((snapshot) => {
          if (!alive) return;
          setPairLive({
            enabled: snapshot.enabled,
            paired: snapshot.devices.length,
            live: snapshot.connectedDeviceIds?.length ?? 0,
          });
        })
        .catch(() => {
          if (alive) setPairLive({ enabled: false, paired: 0, live: 0 });
        });
    };
    read();
    const timer = window.setInterval(read, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [demo]);

  const engine = computerEngineBadge({ computer: bot.computer, cloudBackend: bot.cloudBackend });
  const bridge = bridgeHealth({
    demo,
    connected: state.connected,
    companionEnabled: pairLive?.enabled,
    pairedCount: pairLive?.paired,
    liveCount: pairLive?.live,
  });
  const summary = [engine.label, bridge.label].join(" · ");

  return (
    <section aria-label="V Bot engine and pairing" className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="shell-control flex w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-[11.5px] text-ink-secondary hover:bg-raised/40 hover:text-ink"
      >
        <Server size={12} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown size={12} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-1">
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "companion" })}
            className="shell-control flex w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-ink-secondary hover:bg-raised/40 hover:text-ink"
          >
            <QrCode size={14} />
            Secure pairing
            <Cable size={12} className="ml-auto text-success" />
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
            className="shell-control flex w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-ink-secondary hover:bg-raised/40 hover:text-ink"
          >
            <KeyRound size={14} />
            Provider keys stay on this computer
          </button>
        </div>
      )}
    </section>
  );
}
