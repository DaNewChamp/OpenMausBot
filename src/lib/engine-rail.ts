// Split engines into Cloud (first-party catalog), Local (inject a model),
// and Fleet (models advertised by paired bridges). A missing `access` is
// Cloud so older payloads stay in the top group.
import type { InstanceInfo } from "@/state/store";

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

export function isFleetInstance(instance: {
  instanceId?: string;
  driverKind?: string;
} | undefined): boolean {
  const instanceId = instance?.instanceId ?? "";
  return instanceId.startsWith("fleet/") || instance?.driverKind === "fleet";
}

export function splitEngineRail<T>(instances: readonly T[]): {
  subscription: T[];
  custom: T[];
  fleet: T[];
} {
  const subscription: T[] = [];
  const custom: T[] = [];
  const fleet: T[] = [];
  for (const instance of instances) {
    const row = instance as { access?: InstanceInfo["access"]; instanceId?: string; driverKind?: string };
    if (isFleetInstance(row)) fleet.push(instance);
    else if (isCustomOnly(row)) custom.push(instance);
    else subscription.push(instance);
  }
  return { subscription, custom, fleet };
}
