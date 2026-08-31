export const RUNTIME_PROFILES = [
  "desktop-hub",
  "headless-hub",
  "desktop-client",
] as const;

export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

export function isRuntimeProfile(value: unknown): value is RuntimeProfile {
  return (
    typeof value === "string" &&
    (RUNTIME_PROFILES as readonly string[]).includes(value)
  );
}

export function normalizeRuntimeProfile(value: unknown): RuntimeProfile {
  if (value === undefined || value === null || value === "") {
    return "desktop-hub";
  }
  if (!isRuntimeProfile(value)) throw new Error("invalid runtime profile");
  return value;
}
