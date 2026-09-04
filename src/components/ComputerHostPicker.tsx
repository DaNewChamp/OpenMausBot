import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import {
  fleetHostLabel,
  fleetVmDeployBlockReason,
  hostsWithCapability,
  parseFleetHosts,
  preferredHostId,
  selectedFleetHostId,
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

export function useFleetVmLocation() {
  const { state, dispatch } = useStore();
  const hosts = useFleetHosts();
  const hostId = state.config?.localVm.hostId ?? null;
  const selectedId = selectedFleetHostId(hosts, hostId);
  const selected = hosts.find((host) => host.id === selectedId);
  const blockReason = fleetVmDeployBlockReason(selected);

  const save = async (nextId: string) => {
    const body = await api("/api/local-vm/location", {
      method: "PATCH",
      body: JSON.stringify({ hostId: nextId }),
    });
    if (state.config && body.localVm) {
      dispatch({ type: "configStatus", config: { ...state.config, localVm: body.localVm } });
    }
  };

  return { hosts, hostId, selectedId, selected, blockReason, save };
}

/** Every connected fleet machine, including ones that cannot host a Linux VM yet. */
export function FleetVmLocationPicker({
  hosts,
  value,
  disabled,
  onChange,
}: {
  hosts: readonly FleetHost[];
  value?: string | null;
  disabled?: boolean;
  onChange: (hostId: string) => void;
}) {
  const selected = selectedFleetHostId(hosts, value);
  if (!hosts.length) {
    return (
      <div className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
        No machine is paired. Install V Bot or a bridge on a computer in your fleet, then pick it here.
      </div>
    );
  }
  return (
    <label className="mt-2 block">
      <div className="mb-1 text-[11.5px] font-medium text-ink-secondary">VM location</div>
      <select
        value={selected ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full cursor-pointer rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12.5px] text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {hosts.map((host) => (
          <option key={host.id} value={host.id}>
            {fleetHostLabel(host)}
          </option>
        ))}
      </select>
    </label>
  );
}
