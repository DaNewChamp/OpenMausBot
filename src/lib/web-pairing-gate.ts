import { DEFAULT_WEB_HUB_URL, defaultWebHubUrl, normalizeHubBaseUrl } from "./web-client-session";

export const QR_UNREACHABLE_DEFAULT = "Could not reach the hub. Try again.";
export const QR_UNREACHABLE_CHECK_ADDRESS = "Could not reach the hub. Check the address and try again.";
export const QR_CANCEL_LABEL = "Cancel / Start over";

export function secondsRemaining(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function formatQrCountdown(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds === 1) return "Expires in 1 second";
  return `Expires in ${seconds} seconds`;
}

export function isDefaultWebHubUrl(hubUrl: string, hostname?: string): boolean {
  const expected = hostname === undefined ? defaultWebHubUrl() : defaultWebHubUrl(hostname);
  const current = normalizeHubBaseUrl(hubUrl) ?? hubUrl.trim().replace(/\/+$/, "");
  const defaults = new Set(
    [expected, DEFAULT_WEB_HUB_URL]
      .map((value) => normalizeHubBaseUrl(value) ?? value.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
  return Boolean(current) && defaults.has(current);
}

export function isHubUnreachableMessage(message: string): boolean {
  return /^could not reach (that |the )?hub/i.test(message.trim());
}

export function hubUnreachableCopy(input: { hubUrl: string; advancedOpen: boolean; hostname?: string }): string {
  if (isDefaultWebHubUrl(input.hubUrl, input.hostname) && !input.advancedOpen) {
    return QR_UNREACHABLE_DEFAULT;
  }
  return QR_UNREACHABLE_CHECK_ADDRESS;
}
