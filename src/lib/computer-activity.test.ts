import { describe, expect, it } from "vitest";
import { computerActivityRows } from "./computer-activity";

describe("computerActivityRows", () => {
  it("renders only safe runtime milestones and ignores native protocol records", () => {
    const rows = computerActivityRows({
      entries: [
        { kind: "native", at: "2026-09-05T01:00:00Z", data: { msg: { token: "super-secret" } } },
        { kind: "runtime", at: "2026-09-05T01:00:01Z", data: { eventId: "1", type: "turn.started", createdAt: "2026-09-05T01:00:01Z" } },
        { kind: "runtime", at: "2026-09-05T01:00:02Z", data: { eventId: "2", type: "item.started", itemType: "tool", title: "computer-screenshot: screenshot --token super-secret", createdAt: "2026-09-05T01:00:02Z" } },
        { kind: "runtime", at: "2026-09-05T01:00:03Z", data: { eventId: "3", type: "request.opened", requestType: "permission", tool: "computer_click", summary: "click password=super-secret", createdAt: "2026-09-05T01:00:03Z" } },
        { kind: "runtime", at: "2026-09-05T01:00:04Z", data: { eventId: "4", type: "request.resolved", behavior: "allow", source: "user", createdAt: "2026-09-05T01:00:04Z" } },
        { kind: "runtime", at: "2026-09-05T01:00:05Z", data: { eventId: "5", type: "turn.completed", ok: true, createdAt: "2026-09-05T01:00:05Z" } },
      ],
      total: { runtime: 5, native: 1 },
    });

    expect(rows.map((row) => row.label)).toEqual([
      "Turn started",
      "Captured browser screen",
      "Computer permission requested",
      "Permission approved",
      "Turn finished",
    ]);
    expect(JSON.stringify(rows)).not.toContain("super-secret");
    expect(JSON.stringify(rows)).not.toContain("password");
  });

  it("shows retries and failed turns without exposing provider error text", () => {
    const rows = computerActivityRows({
      entries: [
        { kind: "runtime", at: "2026-09-05T02:00:00Z", data: { eventId: "1", type: "turn.retrying", attempt: 2, delayMs: 500, reason: "api key secret=abc", createdAt: "2026-09-05T02:00:00Z" } },
        { kind: "runtime", at: "2026-09-05T02:00:01Z", data: { eventId: "2", type: "turn.completed", ok: false, stopReason: "provider exploded token=abc", createdAt: "2026-09-05T02:00:01Z" } },
      ],
      total: { runtime: 2, native: 0 },
    });

    expect(rows.map((row) => [row.label, row.tone])).toEqual([
      ["Retrying turn", "warning"],
      ["Turn stopped", "danger"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("abc");
    expect(JSON.stringify(rows)).not.toContain("provider exploded");
  });

  it("keeps the newest useful rows and drops assistant text/reasoning noise", () => {
    const rows = computerActivityRows({
      entries: [
        { kind: "runtime", at: "2026-09-05T03:00:00Z", data: { eventId: "1", type: "content.delta", streamKind: "assistant_text", delta: "secret text", createdAt: "2026-09-05T03:00:00Z" } },
        { kind: "runtime", at: "2026-09-05T03:00:01Z", data: { eventId: "2", type: "item.started", itemType: "reasoning", title: "thinking", createdAt: "2026-09-05T03:00:01Z" } },
        { kind: "runtime", at: "2026-09-05T03:00:02Z", data: { eventId: "3", type: "item.completed", itemType: "tool", ok: false, createdAt: "2026-09-05T03:00:02Z" } },
      ],
      total: { runtime: 3, native: 0 },
    }, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Tool failed", tone: "danger" });
    expect(JSON.stringify(rows)).not.toContain("secret text");
  });
});
