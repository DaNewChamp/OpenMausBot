export const WEB_CLIENT_QUERY = "client";

export function isWebClientMode(search = webClientSearch()): boolean {
  return new URLSearchParams(search).get(WEB_CLIENT_QUERY) === "web";
}

export function webClientSearch(): string {
  try {
    return globalThis.location?.search ?? "";
  } catch {
    return "";
  }
}
