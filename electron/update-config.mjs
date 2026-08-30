const PRIVATE_FEED_ENV = "VBOT_UPDATE_FEED_URL";

export function resolvePrivateUpdateFeed(environment = process.env) {
  const raw = typeof environment?.[PRIVATE_FEED_ENV] === "string" ? environment[PRIVATE_FEED_ENV].trim() : "";
  if (!raw) {
    return {
      enabled: false,
      reason: "not-configured",
      message: "Private V Bot updates are disabled until an update channel is configured.",
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { enabled: false, reason: "invalid", message: "The V Bot update channel is invalid." };
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    return {
      enabled: false,
      reason: "invalid",
      message: "The V Bot update channel must be an HTTPS private feed URL.",
    };
  }

  return { enabled: true, url: parsed.toString().replace(/\/?$/, "/") };
}
