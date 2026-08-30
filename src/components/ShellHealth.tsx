import { Cable, KeyRound, QrCode, Server } from "lucide-react";
import { useEffect, useState } from "react";

import { isDesktopDemoMode } from "@/lib/desktop-demo";
import { bridgeHealth, computerEngineBadge } from "@/lib/shell-status";
import { useStore, type Bot } from "@/state/store";
import { companionBridge } from "./PhoneSetupFlow";

export function ShellHealth({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const demo = isDesktopDemoMode();
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
  const vpsReady = Boolean(state.config?.vps?.configured);

  return (
    <section aria-label="V Bot engine and pairing" className="mt-1 space-y-0.5 border-t border-hairline/30 pt-2">
      <div className="flex flex-wrap gap-1.5">
        <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-raised/70 px-2.5 text-[11.5px] text-ink">
          <Server size={12} className="text-accent" />
          {engine.label}
        </span>
        {vpsReady && engine.kind !== "vps" && (
          <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-raised/70 px-2.5 text-[11.5px] text-ink-secondary">
            VPS ready
          </span>
        )}
        <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-raised/70 px-2.5 text-[11.5px] text-ink">
          <Cable size={12} className="text-success" />
          {bridge.label}
        </span>
      </div>
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "companion" })}
        className="shell-control flex w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ink hover:bg-raised/60"
      >
        <QrCode size={16} className="text-ink-secondary" />
        Secure pairing
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
        className="shell-control flex w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ink hover:bg-raised/60"
      >
        <KeyRound size={16} className="text-ink-secondary" />
        Provider keys stay on this computer
      </button>
    </section>
  );
}
