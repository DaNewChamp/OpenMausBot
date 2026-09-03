export const WEB_CLIENT_QUERY = "client";
export const WEB_CLIENT_HOST = "vbot.posival.com";

export function isWebClientMode(search = webClientSearch(), hostname = webClientHostname()): boolean {
  if (new URLSearchParams(search).get(WEB_CLIENT_QUERY) === "web") return true;
  return hostname.replace(/\.$/, "").toLowerCase() === WEB_CLIENT_HOST;
}

export function webClientSearch(): string {
  try {
    return globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}

export function webClientHostname(): string {
  try {
    return globalThis.location?.hostname ?? "";
  } catch {
    return "";
  }
}
