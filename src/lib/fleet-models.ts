// Shapes for `GET /api/fleet-models`: the machines whose bridges advertise
// local models through the hub. Each payload entry describes one machine and
// nests the models it serves; a row's selectable id is the fleet id string
// (`fleet/<machineSlug>/<modelId>`) the hub routes turns by.

export interface FleetModelOption {
  id: string;
  name: string;
}

export interface FleetMachineGroup {
  machine: string;
  label: string;
  models: FleetModelOption[];
}

interface FleetMachinePayloadEntry {
  id?: string;
  machine?: string;
  label?: string;
  models?: Array<{ id?: string; name?: string }>;
}

/** Strip a trailing model segment from a machine entry id so row ids can be
 * rebuilt as `<machine prefix>/<modelId>` regardless of whether the hub
 * advertises the machine prefix (`fleet/slug`) or a representative model id
 * (`fleet/slug/model`). */
function machinePrefix(id: string, nestedIds: string[]): string {
  const parts = id.split("/");
  if (parts.length > 2 && nestedIds.includes(parts[parts.length - 1] ?? "")) {
    return parts.slice(0, -1).join("/");
  }
  return id;
}

export function groupFleetModels(payload: unknown): FleetMachineGroup[] {
  const entries = Array.isArray((payload as { models?: unknown } | null)?.models)
    ? ((payload as { models: FleetMachinePayloadEntry[] }).models)
    : [];
  const groups: FleetMachineGroup[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const machine = typeof entry.machine === "string" && entry.machine ? entry.machine : "Fleet";
    const label = machine;
    const nested = Array.isArray(entry.models) ? entry.models : [];
    const nestedIds = nested
      .map((model) => (model && typeof model.id === "string" ? model.id : ""))
      .filter(Boolean);
    const prefix = typeof entry.id === "string" && entry.id ? machinePrefix(entry.id, nestedIds) : null;

    const models: FleetModelOption[] = [];
    for (const model of nested) {
      if (!model || typeof model.id !== "string" || !model.id) continue;
      const name = typeof model.name === "string" && model.name ? model.name : model.id;
      models.push({
        id: model.id.startsWith("fleet/") ? model.id : prefix ? `${prefix}/${model.id}` : model.id,
        name,
      });
    }
    // A flattened payload (one entry per model, no nested list) still shows:
    // the entry id itself is the fleet row id.
    if (models.length === 0 && prefix?.startsWith("fleet/")) {
      models.push({ id: prefix, name: prefix.split("/").slice(2).join("/") || prefix });
    }
    if (models.length === 0) continue;

    const existing = groups.find((group) => group.machine === machine && group.label === label);
    if (existing) existing.models.push(...models);
    else groups.push({ machine, label, models });
  }
  return groups;
}

/** Picker/trigger display label for a selected fleet id, preferring names
 * learned from the last fetch over parsing the raw id. */
export function fleetSelectionLabel(groups: FleetMachineGroup[], id: string): string {
  for (const group of groups) {
    const model = group.models.find((option) => option.id === id);
    if (model) return `${group.machine} · ${model.name}`;
  }
  const parts = id.split("/");
  return parts.length > 2 ? `${parts[1]}/${parts.slice(2).join("/")}` : id;
}
