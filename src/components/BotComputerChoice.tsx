import { Monitor, Cpu, Sparkles, PowerOff } from "lucide-react";
import type { FleetHost } from "@/lib/fleet-hosts";
import { cn } from "@/lib/cn";
import { fleetHostStatusText } from "@/lib/fleet-presentation";

export interface BotComputerChoiceProps {
  computer?: "cloud" | "vm" | "local" | "off";
  computerHostId?: string | null;
  hosts: readonly FleetHost[];
  disabled?: boolean;
  onChange: (patch: { computer?: "cloud" | "vm" | "local" | "off"; computerHostId?: string | null }) => void;
}

export function BotComputerChoice({
  computer,
  computerHostId,
  hosts,
  disabled = false,
  onChange,
}: BotComputerChoiceProps) {
  // Map internal computer field to 4 primary modes:
  // "auto": computer === undefined || computer === "cloud"
  // "specific": computer === "local"
  // "vm": computer === "vm"
  // "off": computer === "off"
  const currentMode: "auto" | "specific" | "vm" | "off" =
    computer === "vm"
      ? "vm"
      : computer === "local"
        ? "specific"
        : computer === "off"
          ? "off"
          : "auto";

  const options: Array<{
    id: "auto" | "specific" | "vm" | "off";
    label: string;
    icon: typeof Sparkles;
  }> = [
    { id: "auto", label: "Auto", icon: Sparkles },
    { id: "specific", label: "Specific computer", icon: Monitor },
    { id: "vm", label: "Isolated VM", icon: Cpu },
    { id: "off", label: "Off", icon: PowerOff },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex overflow-hidden rounded-lg border border-hairline/40">
        {options.map((option, i) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            aria-pressed={currentMode === option.id}
            onClick={() => {
              if (option.id === "auto") {
                onChange({ computer: undefined, computerHostId: null });
              } else if (option.id === "specific") {
                const defaultHost = hosts.find((h) => h.online)?.id ?? hosts[0]?.id ?? null;
                onChange({ computer: "local", computerHostId: computerHostId || defaultHost });
              } else if (option.id === "vm") {
                const vmHost = hosts.find((h) => h.capabilities.includes("local-vm") && h.online)?.id ?? hosts[0]?.id ?? null;
                onChange({ computer: "vm", computerHostId: computerHostId || vmHost });
              } else if (option.id === "off") {
                onChange({ computer: "off", computerHostId: null });
              }
            }}
            className={cn(
              "flex-1 py-1.5 text-[12.5px] font-medium transition-colors",
              i > 0 && "border-l border-hairline/40",
              currentMode === option.id
                ? "bg-control text-ink"
                : "text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {currentMode === "auto" && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          Automatically chooses where to run computer tasks based on available fleet capacity.
        </div>
      )}

      {currentMode === "specific" && (
        <div className="flex flex-col gap-2">
          {hosts.length === 0 ? (
            <div className="text-[12px] text-ink-secondary">
              No computers connected to this hub yet.
            </div>
          ) : (
            <label className="block">
              <div className="mb-1 text-[11.5px] font-medium text-ink-secondary">Selected computer</div>
              <select
                aria-label="Selected computer"
                value={computerHostId ?? ""}
                disabled={disabled}
                onChange={(e) => onChange({ computer: "local", computerHostId: e.target.value })}
                className="w-full cursor-pointer rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[12.5px] text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {hosts.map((host) => {
                  const status = fleetHostStatusText(host);
                  const statusSuffix = status === "Offline" ? " (offline)" : "";
                  return (
                    <option key={host.id} value={host.id}>
                      {host.name}{statusSuffix}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          <div className="text-[12px] leading-relaxed text-ink-secondary">
            Runs native shell and automation tools directly on this computer in your fleet.
          </div>
        </div>
      )}

      {currentMode === "vm" && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          Runs tasks inside an isolated Chromium container. Bots take turns driving it.
        </div>
      )}

      {currentMode === "off" && (
        <div className="text-[12px] leading-relaxed text-ink-secondary">
          Computer and browser tools are disabled for this bot.
        </div>
      )}
    </div>
  );
}
