import { useEffect, useState } from "react";
import { api } from "@/state/store";
import {
  hostsWithCapability,
  parseFleetHosts,
  preferredHostId,
  type FleetHost,
} from "@/lib/fleet-hosts";

export function useFleetHosts(): FleetHost[] {
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api("/api/bridges")
        .then((body) => {
          if (alive) setHosts(parseFleetHosts(body));
        })
        .catch(() => {
          if (alive) setHosts([]);
        });
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return hosts;
}

export function ComputerHostPicker({
  hosts,
  capability,
  value,
  disabled,
  onChange,
}: {
  hosts: readonly FleetHost[];
  capability: "local-vm" | "shell";
  value?: string | null;
  disabled?: boolean;
  onChange: (hostId: string) => void;
}) {
  const options = hostsWithCapability(hosts, capability);
  const selected = preferredHostId(options, capability, value);
  if (!options.length) {
    return (
      <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
        {capability === "local-vm"
          ? "No machine with a Linux VM is online. Pair a desktop or bridge that can host one."
          : "No paired machine is online."}
      </div>
    );
  }
  return (
    <label className="mt-2 block">
      <div className="mb-1 text-[11.5px] font-medium text-ink-secondary">Machine</div>
      <select
        value={selected ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full cursor-pointer rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((host) => (
          <option key={host.id} value={host.id} disabled={!host.online && host.id !== selected}>
            {host.name}{host.online ? "" : " (offline)"}
          </option>
        ))}
      </select>
    </label>
  );
}
