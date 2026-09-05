export type ComputerActivityTone = "neutral" | "success" | "warning" | "danger";

export interface ComputerActivityRow {
  id: string;
  at: string;
  label: string;
  tone: ComputerActivityTone;
}

interface InspectorPageLike {
  entries?: unknown;
  total?: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function toolLabel(value: unknown): string {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (/screenshot|capture.*screen/.test(text)) return "Captured browser screen";
  if (/open[_ -]?url|navigate|browser.*open/.test(text)) return "Opened browser page";
  if (/click/.test(text)) return "Clicked in browser";
  if (/type|fill|input/.test(text)) return "Typed in browser";
  if (/scroll/.test(text)) return "Scrolled browser";
  if (/press[_ -]?key|keyboard| key\b/.test(text)) return "Pressed a key";
  if (/computer|browser/.test(text)) return "Used computer tool";
  return "Used a tool";
}

function runtimeRow(entry: Record<string, unknown>): ComputerActivityRow | null {
  const data = record(entry.data) ? entry.data : null;
  if (!data || typeof data.type !== "string") return null;
  const at = typeof entry.at === "string"
    ? entry.at
    : typeof data.createdAt === "string"
      ? data.createdAt
      : "";
  const id = typeof data.eventId === "string" ? data.eventId : `${data.type}:${at}`;

  switch (data.type) {
    case "turn.started":
      return { id, at, label: "Turn started", tone: "neutral" };
    case "turn.retrying":
      return { id, at, label: "Retrying turn", tone: "warning" };
    case "turn.completed":
      return data.ok === true
        ? { id, at, label: "Turn finished", tone: "success" }
        : { id, at, label: "Turn stopped", tone: "danger" };
    case "item.started":
      if (data.itemType !== "tool") return null;
      return { id, at, label: toolLabel(data.title), tone: "neutral" };
    case "item.completed":
      if (data.itemType !== "tool") return null;
      return data.ok === false
        ? { id, at, label: "Tool failed", tone: "danger" }
        : { id, at, label: "Tool finished", tone: "success" };
    case "request.opened":
      if (data.requestType !== "permission") return null;
      return {
        id,
        at,
        label: /computer|browser|screenshot|click|scroll|type|key|open[_ -]?url/i.test(String(data.tool ?? ""))
          ? "Computer permission requested"
          : "Permission requested",
        tone: "warning",
      };
    case "request.resolved":
      if (data.behavior === "allow") return { id, at, label: "Permission approved", tone: "success" };
      if (data.behavior === "deny") return { id, at, label: "Permission denied", tone: "danger" };
      return null;
    case "session.exited":
      return { id, at, label: "Computer session ended", tone: "neutral" };
    default:
      return null;
  }
}

export function computerActivityRows(page: InspectorPageLike, limit = 8): ComputerActivityRow[] {
  const entries = Array.isArray(page.entries) ? page.entries : [];
  const rows: ComputerActivityRow[] = [];
  for (const entry of entries) {
    if (!record(entry) || entry.kind !== "runtime") continue;
    const row = runtimeRow(entry);
    if (row) rows.push(row);
  }
  return rows.slice(-Math.max(1, limit));
}
