import { WIRE_PLATFORMS as SHARED_WIRE_PLATFORMS } from "./runtime-vocabulary.mjs";

export const WIRE_PLATFORMS = SHARED_WIRE_PLATFORMS;

export type WirePlatform = (typeof WIRE_PLATFORMS)[number];

export function isWirePlatform(value: unknown): value is WirePlatform {
  return (
    typeof value === "string" &&
    (WIRE_PLATFORMS as readonly string[]).includes(value)
  );
}

export function normalizeWirePlatform(value: unknown): WirePlatform {
  if (value === "win32") return "windows";
  if (isWirePlatform(value)) return value;
  throw new Error("invalid wire platform");
}
