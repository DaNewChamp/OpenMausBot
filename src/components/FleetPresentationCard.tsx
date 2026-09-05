import { Monitor, Server } from "lucide-react";
import {
  AVAILABLE_COMPUTERS_SECTION_FOOTER,
  AVAILABLE_COMPUTERS_SECTION_TITLE,
  HUB_SECTION_TITLE,
  computerSummary,
  connectedComputerCount,
  fleetHostStatusText,
} from "@/lib/fleet-presentation";
import type { FleetHost } from "@/lib/fleet-hosts";
import { Card } from "./SettingsPrimitives";

export function FleetPresentationCard({
  hubName = "Primary Hub",
  hosts = [],
}: {
  hubName?: string;
  hosts?: readonly FleetHost[];
}) {
  const connectedCount = connectedComputerCount(hosts);
  const summary = computerSummary(1, connectedCount);

  return (
    <div className="flex flex-col gap-4">
      <Card title={HUB_SECTION_TITLE} subtitle={summary}>
        <div className="flex items-center gap-3 rounded-xl bg-inset px-3 py-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-control text-ink">
            <Server size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-medium text-ink">{hubName}</div>
            <div className="text-[12px] text-success">Online · Paired</div>
          </div>
        </div>
      </Card>

      <Card
        title={AVAILABLE_COMPUTERS_SECTION_TITLE}
        subtitle={AVAILABLE_COMPUTERS_SECTION_FOOTER}
      >
        {hosts.length === 0 ? (
          <div className="text-[13px] leading-relaxed text-ink-secondary">
            No computers connected to this hub yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {hosts.map((host) => {
              const status = fleetHostStatusText(host);
              const isOnline = status === "Online";
              return (
                <li key={host.id} className="flex items-center gap-3 rounded-xl bg-inset px-3 py-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-control text-ink-secondary">
                    <Monitor size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{host.name}</div>
                    <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                      <span className={`size-1.5 rounded-full ${isOnline ? "bg-success" : "bg-ink-secondary/40"}`} />
                      <span>{status}</span>
                      {host.capabilities.includes("local-vm") && (
                        <>
                          <span>·</span>
                          <span>Isolated VM</span>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
