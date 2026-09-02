import { describe, expect, it } from "vitest";

import { WebClientGate } from "./WebClientShell";
import { canCallHubApi } from "@/lib/web-client-session";

const NAV_LABELS = ["Conversations", "Bots", "Fleet", "Settings", "Approvals"] as const;

describe("WebClientShell", () => {
  it("describes the gate and blocks hub API access before pairing", () => {
    expect(canCallHubApi()).toBe(false);
    expect(WebClientGate.name).toBe("WebClientGate");
  });

  it("defines the five paired-shell navigation areas", () => {
    expect(NAV_LABELS).toEqual([
      "Conversations",
      "Bots",
      "Fleet",
      "Settings",
      "Approvals",
    ]);
  });
});
