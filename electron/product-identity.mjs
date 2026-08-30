import { join } from "node:path";

/**
 * Public V Bot naming with the legacy OpenMausBot identifiers kept in place
 * for installed clients, deep links, and existing data directories.
 */
export const PRODUCT_NAME = "V Bot";
export const LEGACY_PRODUCT_NAME = "OpenMausBot";
export const LEGACY_PROTOCOL = "openmausbot";
export const PRODUCT_PROTOCOL = "vbot";
export const LEGACY_BUNDLE_ID = "com.openmausbot.app";

/**
 * Pick the existing OpenMausBot data directory when it is present. V Bot does
 * not copy or delete a user's state during a brand transition: keeping the
 * legacy directory as the active path makes rollback to an older build safe
 * and avoids splitting transcripts, credentials, and pairing state.
 */
export function resolveCompatibleUserDataPath({ currentPath, appDataPath, exists }) {
  if (typeof currentPath !== "string" || !currentPath) return currentPath;
  if (typeof appDataPath !== "string" || !appDataPath || typeof exists !== "function") return currentPath;
  const legacyPath = join(appDataPath, LEGACY_PRODUCT_NAME);
  return exists(legacyPath) ? legacyPath : currentPath;
}
