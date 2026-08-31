import { z } from "zod";

import type { ControlPlaneAuth } from "./auth";
import { accountSession } from "./auth";
import { HTTPError, json, readBoundedJSON } from "./http";
import { requireInstallation, isValidOpaqueId } from "./installations";
import {
  isRuntimeProfile,
  RUNTIME_PROFILES,
} from "../../../shared/runtime-profile";
import {
  isWirePlatform,
  WIRE_PLATFORMS,
} from "../../../shared/runtime-platform";

/** The Worker validator and the shared runtime vocabulary are one tuple. */
export { RUNTIME_PROFILES, WIRE_PLATFORMS };
export const WORKER_RUNTIME_PROFILES = RUNTIME_PROFILES;
export const WORKER_WIRE_PLATFORMS = WIRE_PLATFORMS;

const capabilitySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const runtimeProfileSchema = z.enum(RUNTIME_PROFILES);
export const presenceSchema = z.strictObject({
  runtimeProfile: runtimeProfileSchema,
  appVersion: z.string().trim().min(1).max(64).optional(),
  capabilities: z.array(capabilitySchema).max(32),
});

const PRESENCE_TTL_MS = 90_000;

type EndpointStatus = "pending" | "provisioning" | "ready" | "deleting" | "deleted" | "error";

interface FleetRow {
  id: string;
  client_instance_id: string;
  display_name: string;
  platform: string;
  runtime_profile: string | null;
  app_version: string | null;
  created_at: number;
  last_seen_at: number | null;
  presence_updated_at: number | null;
  capabilities_json: string | null;
  endpoint_hostname: string | null;
  endpoint_status: EndpointStatus | null;
}

function normalizeCapabilities(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function decodeStoredCapabilities(value: string | null): string[] {
  if (value === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  const validated = z.array(capabilitySchema).max(32).safeParse(parsed);
  if (!validated.success) {
    return [];
  }
  const normalized = normalizeCapabilities(validated.data);
  return normalized.length === validated.data.length
    && normalized.every((capability, index) => capability === validated.data[index])
    ? normalized
    : [];
}

function endpointMetadata(hostname: string, status: EndpointStatus) {
  let url: URL;
  try {
    url = new URL(`https://${hostname}`);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) return null;
  return { url: url.origin, status };
}

async function requireAccount(request: Request, auth: ControlPlaneAuth) {
  const session = await accountSession(request, auth);
  if (!session) throw new HTTPError(401, "unauthorized");
  return session;
}

/** Record one authenticated installation heartbeat without accepting account bearers. */
export async function updateInstallationPresence(request: Request, env: Env): Promise<Response> {
  const installation = await requireInstallation(request, env);
  const parsed = presenceSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");

  const capabilities = normalizeCapabilities(parsed.data.capabilities);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE installations
        SET runtime_profile = ?,
            capabilities_json = ?,
            app_version = COALESCE(?, app_version),
            last_seen_at = ?,
            presence_updated_at = ?,
            updated_at = ?
      WHERE id = ? AND revoked_at IS NULL`,
  ).bind(
    parsed.data.runtimeProfile,
    JSON.stringify(capabilities),
    parsed.data.appVersion ?? null,
    now,
    now,
    now,
    installation.installation_id,
  ).run();

  return json({ ok: true });
}

function fleetInstallation(row: FleetRow, now: number) {
  if (
    !isValidOpaqueId(row.id)
    || !isValidOpaqueId(row.client_instance_id)
    || !isWirePlatform(row.platform)
  ) return null;

  const runtimeProfile = isRuntimeProfile(row.runtime_profile)
    ? row.runtime_profile
    : "desktop-hub";
  const endpoint = row.endpoint_status !== null
    && row.endpoint_status !== "deleted"
    && row.endpoint_hostname !== null
    ? endpointMetadata(row.endpoint_hostname, row.endpoint_status)
    : null;

  return {
    id: row.id,
    clientInstanceId: row.client_instance_id,
    name: row.display_name,
    platform: row.platform,
    runtimeProfile,
    appVersion: row.app_version,
    capabilities: decodeStoredCapabilities(row.capabilities_json),
    lastSeenAt: row.last_seen_at,
    online: row.presence_updated_at !== null
      && now - row.presence_updated_at <= PRESENCE_TTL_MS,
    endpoint,
  };
}

/** List safe, owner-scoped installation metadata for an authenticated account. */
export async function listFleet(
  request: Request,
  env: Env,
  auth: ControlPlaneAuth,
): Promise<Response> {
  const session = await requireAccount(request, auth);
  const result = await env.DB.prepare(
    `SELECT i.id, i.client_instance_id, i.display_name, i.platform,
            i.runtime_profile, i.app_version, i.created_at, i.last_seen_at,
            i.presence_updated_at, i.capabilities_json,
            e.hostname AS endpoint_hostname, e.status AS endpoint_status
       FROM installations i
       LEFT JOIN installation_endpoints e ON e.installation_id = i.id
      WHERE i.owner_user_id = ? AND i.revoked_at IS NULL
      ORDER BY i.created_at ASC, i.id ASC
      LIMIT 100`,
  ).bind(session.user.id).all<FleetRow>();

  const now = Date.now();
  return json({
    installations: result.results
      .map((row) => fleetInstallation(row, now))
      .filter((row): row is NonNullable<typeof row> => row !== null),
  });
}
