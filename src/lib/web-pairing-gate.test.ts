import { describe, expect, it } from "vitest";

import { DEFAULT_WEB_HUB_URL } from "./web-client-session";
import {
  formatQrCountdown,
  hubUnreachableCopy,
  isDefaultWebHubUrl,
  isHubUnreachableMessage,
  QR_UNREACHABLE_CHECK_ADDRESS,
  QR_UNREACHABLE_DEFAULT,
  secondsRemaining,
} from "./web-pairing-gate";

describe("QR gate countdown", () => {
  it("reports whole seconds remaining from expiresAt and clamps at zero", () => {
    const now = 1_700_000_000_000;
    expect(secondsRemaining(now + 87_400, now)).toBe(88);
    expect(secondsRemaining(now + 1_000, now)).toBe(1);
    expect(secondsRemaining(now - 1, now)).toBe(0);
    expect(formatQrCountdown(87)).toBe("Expires in 87 seconds");
    expect(formatQrCountdown(1)).toBe("Expires in 1 second");
    expect(formatQrCountdown(0)).toBe("");
  });
});

describe("QR hub-unreachable copy", () => {
  it("does not mention checking the address when the default hub is used and Advanced is collapsed", () => {
    expect(
      hubUnreachableCopy({ hubUrl: DEFAULT_WEB_HUB_URL, advancedOpen: false }),
    ).toBe(QR_UNREACHABLE_DEFAULT);
    expect(QR_UNREACHABLE_DEFAULT).toBe("Could not reach the hub. Try again.");
    expect(QR_UNREACHABLE_DEFAULT).not.toMatch(/address/i);
    expect(isDefaultWebHubUrl(DEFAULT_WEB_HUB_URL)).toBe(true);
    expect(isDefaultWebHubUrl(`${DEFAULT_WEB_HUB_URL}/`)).toBe(true);
  });

  it("mentions checking the address when Advanced is open or the hub is a non-default origin", () => {
    expect(hubUnreachableCopy({ hubUrl: DEFAULT_WEB_HUB_URL, advancedOpen: true })).toBe(
      QR_UNREACHABLE_CHECK_ADDRESS,
    );
    expect(
      hubUnreachableCopy({ hubUrl: "https://hub.example:8810", advancedOpen: false }),
    ).toBe(QR_UNREACHABLE_CHECK_ADDRESS);
    expect(QR_UNREACHABLE_CHECK_ADDRESS).toMatch(/address/i);
    expect(isHubUnreachableMessage("Could not reach that hub. Check the address and your connection.")).toBe(
      true,
    );
  });
});
