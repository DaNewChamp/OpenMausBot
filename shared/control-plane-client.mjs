import {
  RUNTIME_PROFILES as SHARED_RUNTIME_PROFILES,
  WIRE_PLATFORMS as SHARED_WIRE_PLATFORMS,
} from "./runtime-vocabulary.mjs";

const INSTALLATION_CREDENTIAL =
  /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const MAX_OPAQUE_ID_LENGTH = 256;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_PROFILES = new Set(SHARED_RUNTIME_PROFILES);
const WIRE_PLATFORMS = new Set(SHARED_WIRE_PLATFORMS);
const ENDPOINT_STATUSES = new Set([
  "pending",
  "provisioning",
  "ready",
  "deleting",
  "error",
]);
const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_CAPABILITIES = 32;
const MAX_FLEET_INSTALLATIONS = 100;
const INSTALLATION_CREDENTIAL_PREFIX = "omb_install_";

const stringValue = (value) => (typeof value === "string" ? value : null);

const isPlainRecord = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const constructor = value.constructor;
    if (constructor === undefined || typeof constructor !== "function") return true;
    const prototype = constructor.prototype;
    return (
      typeof prototype === "object" &&
      prototype !== null &&
      Object.prototype.hasOwnProperty.call(prototype, "isPrototypeOf")
    );
  } catch {
    return false;
  }
};

const plainObject = (value) => {
  if (!isPlainRecord(value)) return null;
  const record = {};
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (typeof key !== "string") return null;
      if (key === "__proto__") continue;
      record[key] = value[key];
    }
  } catch {
    return null;
  }
  return record;
};

/** Existing installation and client IDs are opaque. UUIDs are a valid
 * generation choice, but readers must retain bounded legacy values unchanged. */
export function isValidOpaqueId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    !/[\p{Cc}\p{Cs}\p{Cf}]/u.test(value)
  );
}

const validClientInstance = isValidOpaqueId;

const boundedSecret = (value, maximum = 8_192) =>
  typeof value === "string" &&
  value.length >= 20 &&
  value.length <= maximum &&
  /^\S+$/.test(value)
    ? value
    : null;

// Installation credentials are deliberately distinguishable from account
// bearers. Reject the reserved prefix before any account-authenticated I/O so
// a credential can never be replayed against an account or fleet endpoint.
const boundedAccountToken = (value) => {
  const token = boundedSecret(value);
  return token !== null && !token.startsWith(INSTALLATION_CREDENTIAL_PREFIX)
    ? token
    : null;
};

export class ControlPlaneError extends Error {
  constructor(code, status = 0, requestId = "") {
    super(code);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = status;
    this.requestId = REQUEST_ID.test(requestId) ? requestId : "";
  }
}

function statusErrorCode(status) {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "control_plane_unavailable";
  return "request_failed";
}

/** Production accepts HTTPS only. A loopback HTTP origin remains available
 * for an explicitly configured development Worker. Paths, credentials, and
 * query strings are rejected so every request stays under the audited API. */
export function normalizeControlPlaneURL(value) {
  const input = stringValue(value)?.trim() ?? "";
  if (!input) return "";
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return "";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

export function normalizeAccountEmail(value) {
  const input = stringValue(value);
  const email = input !== null && input.length <= 254 ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function validatedUser(value) {
  const user = plainObject(value);
  const email = normalizeAccountEmail(user?.email);
  const idInput = stringValue(user?.id);
  const id = idInput !== null && idInput.length >= 1 && idInput.length <= 256
    ? idInput
    : null;
  if (!email || !id) return null;
  return { id, email };
}

function validatedInstallation(value) {
  const installation = plainObject(value);
  const id = stringValue(installation?.id);
  const clientInstanceId = stringValue(installation?.clientInstanceId);
  if (
    id === null ||
    !isValidOpaqueId(id) ||
    clientInstanceId === null ||
    !validClientInstance(clientInstanceId)
  ) {
    return null;
  }
  return {
    id,
    clientInstanceId,
    name: stringValue(installation.name) ?? "This computer",
    platform: installation.platform,
    appVersion: stringValue(installation.appVersion),
  };
}

function validatedEndpoint(value) {
  const endpoint = plainObject(value);
  const endpointURL = stringValue(endpoint?.url);
  if (endpointURL === null) return null;
  let url;
  try {
    url = new URL(endpointURL);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { url: url.origin };
}

/** Return an object only when every enumerable property is explicitly named.
 * Fleet responses are a trust boundary, so unlike the legacy installation
 * reader this helper also rejects unknown and missing fields. */
function strictRecord(value, keys, requiredKeys = keys) {
  if (!isPlainRecord(value)) return null;
  const allowed = new Set(keys);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (typeof key !== "string" || !allowed.has(key)) return null;
    }
    for (const key of requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    }
  } catch {
    return null;
  }
  return value;
}

function validFleetString(value, maximum) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Cs}\p{Cf}]/u.test(value)
  );
}

function validTimestamp(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validCapabilities(value) {
  try {
    if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) return null;
    // Object.keys also rejects sparse arrays and enumerable non-index fields.
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) return null;
    const capabilities = [];
    const seen = new Set();
    for (const capability of value) {
      if (typeof capability !== "string" || !CAPABILITY_NAME.test(capability) || seen.has(capability)) {
        return null;
      }
      seen.add(capability);
      capabilities.push(capability);
    }
    return capabilities;
  } catch {
    return null;
  }
}

function validatedFleetEndpoint(value) {
  try {
    if (value === null) return null;
    const endpoint = strictRecord(value, ["url", "status"]);
    if (!endpoint || typeof endpoint.url !== "string" || !ENDPOINT_STATUSES.has(endpoint.status)) {
      return null;
    }
    let url;
    try {
      url = new URL(endpoint.url);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return { url: url.origin, status: endpoint.status };
  } catch {
    return null;
  }
}

function validatedFleetInstallation(value) {
  try {
    const installation = strictRecord(value, [
      "id",
      "clientInstanceId",
      "name",
      "platform",
      "runtimeProfile",
      "appVersion",
      "capabilities",
      "lastSeenAt",
      "online",
      "endpoint",
    ]);
    if (!installation) return null;
    const capabilities = validCapabilities(installation.capabilities);
    if (
      !isValidOpaqueId(installation.id) ||
      !isValidOpaqueId(installation.clientInstanceId) ||
      !validFleetString(installation.name, 80) ||
      !WIRE_PLATFORMS.has(installation.platform) ||
      !RUNTIME_PROFILES.has(installation.runtimeProfile) ||
      (installation.appVersion !== null && !validFleetString(installation.appVersion, 64)) ||
      !capabilities ||
      !validTimestamp(installation.lastSeenAt) ||
      typeof installation.online !== "boolean"
    ) {
      return null;
    }
    const endpoint = validatedFleetEndpoint(installation.endpoint);
    if (installation.endpoint !== null && !endpoint) return null;
    return {
      id: installation.id,
      clientInstanceId: installation.clientInstanceId,
      name: installation.name,
      platform: installation.platform,
      runtimeProfile: installation.runtimeProfile,
      appVersion: installation.appVersion,
      capabilities,
      lastSeenAt: installation.lastSeenAt,
      online: installation.online,
      endpoint,
    };
  } catch {
    return null;
  }
}

/** Decode the owner-scoped fleet response without carrying unknown fields. */
export function decodeFleetResponse(value) {
  try {
    const payload = strictRecord(value, ["installations"]);
    if (!payload || !Array.isArray(payload.installations) || payload.installations.length > MAX_FLEET_INSTALLATIONS) {
      return null;
    }
    const installations = [];
    for (const value of payload.installations) {
      const installation = validatedFleetInstallation(value);
      if (!installation) return null;
      installations.push(installation);
    }
    return installations;
  } catch {
    return null;
  }
}

function presenceBody(value) {
  try {
    const input = strictRecord(value, ["runtimeProfile", "appVersion", "capabilities"], ["runtimeProfile", "capabilities"]);
    if (!input || !RUNTIME_PROFILES.has(input.runtimeProfile)) return null;
    const capabilities = validCapabilities(input.capabilities);
    if (!capabilities) return null;
    if (input.appVersion !== undefined && !validFleetString(input.appVersion, 64)) return null;
    const body = { runtimeProfile: input.runtimeProfile };
    if (input.appVersion !== undefined) body.appVersion = input.appVersion;
    body.capabilities = [...capabilities];
    return body;
  } catch {
    return null;
  }
}

export function createControlPlaneClient({
  baseURL,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = 15_000,
  healthTimeoutMs = 3_000,
}) {
  const origin = normalizeControlPlaneURL(baseURL);
  if (!origin) throw new ControlPlaneError("control_plane_unavailable");

  const request = async (
    path,
    { method = "GET", token, body, allowEmpty = false, deadlineMs = timeoutMs } = {},
  ) => {
    const headers = new Headers({ accept: "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    // Node's fetch sends `Sec-Fetch-Mode: cors` even though Electron is a
    // native client. Better Auth 1.7 treats that Fetch Metadata as a
    // browser-shaped request and requires a trusted Origin. Our exact,
    // validated control-plane origin is already trusted by the Worker; send
    // it only to Better Auth routes instead of weakening server CSRF checks.
    if (path.startsWith("/api/auth/")) headers.set("origin", origin);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    let response;
    try {
      const init = {
        method,
        headers,
        redirect: "error",
        signal: timeoutSignal(deadlineMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await fetchImpl(`${origin}${path}`, init);
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw new ControlPlaneError("network_unavailable");
    }

    let payload = null;
    if (response.status !== 204) {
      payload = await response.json().catch(() => null);
    }
    if (!response.ok) {
      const rawCode = stringValue(plainObject(payload)?.error);
      const code = rawCode !== null && /^[a-z0-9_]{1,64}$/.test(rawCode)
        ? rawCode
        : null;
      throw new ControlPlaneError(
        code ?? statusErrorCode(response.status),
        response.status,
        response.headers.get("x-request-id") ?? "",
      );
    }
    if (!allowEmpty && !plainObject(payload)) {
      throw new ControlPlaneError("invalid_response", response.status);
    }
    return { response, payload };
  };

  const accountInstallations = async (accountToken) => {
    if (!boundedAccountToken(accountToken)) throw new ControlPlaneError("signed_out", 401);
    const { payload } = await request("/v1/installations", { token: accountToken });
    if (!Array.isArray(payload.installations)) {
      throw new ControlPlaneError("invalid_response");
    }
    const installations = payload.installations.map(validatedInstallation);
    if (installations.some((installation) => !installation)) {
      throw new ControlPlaneError("invalid_response");
    }
    return installations;
  };

  return {
    origin,

    async health() {
      const { payload } = await request("/healthz", {
        deadlineMs: Math.min(timeoutMs, healthTimeoutMs),
      });
      if (
        payload.ok !== true ||
        payload.service !== "openmausbot-control-plane"
      ) {
        throw new ControlPlaneError("control_plane_unavailable");
      }
      return true;
    },

    async requestOTP(rawEmail) {
      const email = normalizeAccountEmail(rawEmail);
      if (!email) throw new ControlPlaneError("invalid_email");
      await request("/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        body: { email, type: "sign-in" },
      });
      // The server deliberately gives the same result for known and unknown
      // addresses. Preserve that enumeration-safe contract in the UI.
      return { email };
    },

    async verifyOTP(rawEmail, rawOTP) {
      const email = normalizeAccountEmail(rawEmail);
      const otpInput = stringValue(rawOTP);
      const otp = otpInput !== null && otpInput.length <= 32
        ? otpInput.replaceAll(/\s|-/g, "")
        : "";
      if (!email) throw new ControlPlaneError("invalid_email");
      if (!/^\d{8}$/.test(otp)) throw new ControlPlaneError("invalid_otp");
      const { response, payload } = await request("/api/auth/sign-in/email-otp", {
        method: "POST",
        body: { email, otp, name: email.split("@", 1)[0] },
      });
      // Better Auth's response JSON includes its raw database token. The
      // signed bearer plugin intentionally publishes a different credential
      // in this header; only that signed value may cross our API boundary.
      const accountToken = boundedAccountToken(response.headers.get("set-auth-token"));
      const user = validatedUser(payload.user);
      if (!accountToken || !user || user.email !== email) {
        throw new ControlPlaneError("invalid_response", response.status);
      }
      return { accountToken, user };
    },

    async me(accountToken) {
      if (!boundedAccountToken(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/me", { token: accountToken });
      const user = validatedUser(payload.user);
      if (!user) throw new ControlPlaneError("invalid_response");
      return user;
    },

    async listInstallations(accountToken) {
      return accountInstallations(accountToken);
    },

    async listFleet(accountToken) {
      if (!boundedAccountToken(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const { payload } = await request("/v1/fleet", { token: accountToken });
      const installations = decodeFleetResponse(payload);
      if (!installations) throw new ControlPlaneError("invalid_response");
      return installations;
    },

    async updatePresence(installationCredential, presence) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const body = presenceBody(presence);
      if (!body) throw new ControlPlaneError("invalid_request");
      const { payload } = await request("/v1/installations/self/presence", {
        method: "PUT",
        token: installationCredential,
        body,
      });
      if (payload.ok !== true) throw new ControlPlaneError("invalid_response");
    },

    async ensureInstallation({ accountToken, currentCredential, clientInstanceId, name, platform, appVersion }) {
      if (
        !validClientInstance(clientInstanceId)
      ) {
        throw new ControlPlaneError("invalid_client_identity");
      }

      if (
        typeof currentCredential === "string" &&
        INSTALLATION_CREDENTIAL.test(currentCredential)
      ) {
        try {
          const { payload } = await request("/v1/installations/self", { token: currentCredential });
          const installation = validatedInstallation(payload.installation);
          if (installation?.clientInstanceId === clientInstanceId) {
            return {
              installation,
              credential: currentCredential,
              credentialExpiresAt:
                Number.isSafeInteger(payload.credentialExpiresAt) ? payload.credentialExpiresAt : null,
            };
          }
        } catch (error) {
          // A transient outage must not rotate a perfectly usable identity.
          // Only a definitive 401 falls through to account recovery.
          if (!(error instanceof ControlPlaneError) || error.status !== 401) throw error;
        }
      }

      if (!boundedAccountToken(accountToken)) throw new ControlPlaneError("signed_out", 401);
      const installations = await accountInstallations(accountToken);
      const existing = installations.find((item) => item.clientInstanceId === clientInstanceId);
      const result = existing
        ? await request(`/v1/installations/${encodeURIComponent(existing.id)}/credentials/rotate`, {
            method: "POST",
            token: accountToken,
          })
        : await request("/v1/installations", {
            method: "POST",
            token: accountToken,
            body: { clientInstanceId, name, platform, appVersion },
          });
      const installation = existing ?? validatedInstallation(result.payload.installation);
      const credential = stringValue(result.payload.credential);
      if (!installation || credential === null || !INSTALLATION_CREDENTIAL.test(credential)) {
        throw new ControlPlaneError("invalid_response");
      }
      return {
        installation,
        credential,
        credentialExpiresAt:
          Number.isSafeInteger(result.payload.credentialExpiresAt)
            ? result.payload.credentialExpiresAt
            : null,
      };
    },

    async ensureEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      const { payload } = await request("/v1/installations/self/endpoint", {
        method: "POST",
        token: installationCredential,
      });
      const endpoint = validatedEndpoint(payload.endpoint);
      const connectorToken = boundedSecret(payload.connectorToken, 16_384);
      if (!endpoint || !connectorToken) throw new ControlPlaneError("invalid_response");
      return { endpoint, connectorToken };
    },

    async deleteEndpoint(installationCredential) {
      if (
        typeof installationCredential !== "string" ||
        !INSTALLATION_CREDENTIAL.test(installationCredential)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request("/v1/installations/self/endpoint", {
        method: "DELETE",
        token: installationCredential,
        allowEmpty: true,
      });
    },

    async revokeInstallation(accountToken, installationId) {
      if (
        !boundedAccountToken(accountToken) ||
        typeof installationId !== "string" ||
        !isValidOpaqueId(installationId)
      ) {
        throw new ControlPlaneError("signed_out", 401);
      }
      await request(`/v1/installations/${encodeURIComponent(installationId)}`, {
        method: "DELETE",
        token: accountToken,
        allowEmpty: true,
      });
    },

    async signOut(accountToken) {
      if (!boundedAccountToken(accountToken)) return;
      await request("/api/auth/sign-out", {
        method: "POST",
        token: accountToken,
      });
    },
  };
}
