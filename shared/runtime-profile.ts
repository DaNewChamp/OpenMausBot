import { RUNTIME_PROFILES as SHARED_RUNTIME_PROFILES } from "./runtime-vocabulary.mjs";

export const RUNTIME_PROFILES = SHARED_RUNTIME_PROFILES;

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
