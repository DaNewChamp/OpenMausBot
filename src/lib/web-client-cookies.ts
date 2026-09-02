const secure =
  typeof globalThis.location !== "undefined" && globalThis.location.protocol === "https:";

export function setClientCookie(name: string, value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  document.cookie = parts.join("; ");
}

export function getClientCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

export function clearClientCookie(name: string) {
  setClientCookie(name, "", 0);
}
