import {
  ControlPlaneError,
  isValidOpaqueId,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";
import {
  managedCompanionTunnelAccess,
  withManagedCompanionTunnelAccess,
  withoutManagedCompanionTunnelAccess,
} from "./managed-companion-tunnel.mjs";

export const DEFAULT_COMPANION_CONTROL_PLANE_URL = "https://accounts.openmausbot.com";

export const COMPANION_CLIENT_INSTANCE_FIELD = "companionClientInstanceId";
export const COMPANION_ACCOUNT_TOKEN_FIELD = "companionAccountToken";
export const COMPANION_ACCOUNT_USER_ID_FIELD = "companionAccountUserId";
export const COMPANION_ACCOUNT_EMAIL_FIELD = "companionAccountEmail";
export const COMPANION_INSTALLATION_ID_FIELD = "companionInstallationId";
export const COMPANION_INSTALLATION_CREDENTIAL_FIELD = "companionInstallationCredential";
export const COMPANION_INSTALLATION_EXPIRY_FIELD = "companionInstallationCredentialExpiresAt";
export const COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD = "companionAccountCleanupPending";

const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_HEALTH_CACHE_MS = 30_000;

const ownString = (document, field) =>
  typeof document?.[field] === "string" ? document[field] : "";

/** Packaged builds have a safe hosted default. Development must opt into an
 * exact HTTPS origin (or HTTP loopback Worker) so a contributor never sends
 * an OTP or bearer to an accidental host. An explicitly invalid override
 * disables the feature instead of silently falling back to production. */
export function resolveCompanionControlPlaneURL({
  isPackaged,
  environment = process.env,
} = {}) {
  if (Object.hasOwn(environment, "OMB_CONTROL_PLANE_URL")) {
    return normalizeControlPlaneURL(environment.OMB_CONTROL_PLANE_URL);
  }
  return isPackaged ? DEFAULT_COMPANION_CONTROL_PLANE_URL : "";
}

export function companionAccountCleanupPending(credentials) {
  return credentials?.[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] === true;
}

function storedAccount(credentials) {
  const email = normalizeAccountEmail(ownString(credentials, COMPANION_ACCOUNT_EMAIL_FIELD));
  const userId = ownString(credentials, COMPANION_ACCOUNT_USER_ID_FIELD);
  if (!email || !userId || userId.length > 256) return null;
  return {
    email,
    userId,
    accountToken: ownString(credentials, COMPANION_ACCOUNT_TOKEN_FIELD),
    installationId: isValidOpaqueId(ownString(credentials, COMPANION_INSTALLATION_ID_FIELD))
      ? credentials[COMPANION_INSTALLATION_ID_FIELD]
      : "",
    installationCredential: INSTALLATION_CREDENTIAL.test(
      ownString(credentials, COMPANION_INSTALLATION_CREDENTIAL_FIELD),
    )
      ? credentials[COMPANION_INSTALLATION_CREDENTIAL_FIELD]
      : "",
  };
}

function withoutCompanionAccount(credentials) {
  const next = withoutManagedCompanionTunnelAccess(credentials);
  for (const field of [
    COMPANION_ACCOUNT_TOKEN_FIELD,
    COMPANION_ACCOUNT_USER_ID_FIELD,
    COMPANION_ACCOUNT_EMAIL_FIELD,
    COMPANION_INSTALLATION_ID_FIELD,
    COMPANION_INSTALLATION_CREDENTIAL_FIELD,
    COMPANION_INSTALLATION_EXPIRY_FIELD,
    COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD,
  ]) {
    delete next[field];
  }
  // The stable opaque ID identifies this installation, not an account. Keeping it across
  // sign-outs lets a same-account recovery adopt the existing server record
  // rather than manufacturing a new computer every time.
  return next;
}

function withProvisionedAccount(credentials, { accountToken, user, installation, provision }) {
  const withEndpoint = withManagedCompanionTunnelAccess(credentials, provision);
  const next = {
    ...withEndpoint,
    [COMPANION_ACCOUNT_TOKEN_FIELD]: accountToken,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: user.id,
    [COMPANION_ACCOUNT_EMAIL_FIELD]: user.email,
    [COMPANION_INSTALLATION_ID_FIELD]: installation.installation.id,
    [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: installation.credential,
  };
  if (Number.isSafeInteger(installation.credentialExpiresAt)) {
    next[COMPANION_INSTALLATION_EXPIRY_FIELD] = installation.credentialExpiresAt;
  } else {
    delete next[COMPANION_INSTALLATION_EXPIRY_FIELD];
  }
  delete next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD];
  return next;
}

function withAuthenticatedAccount(
  credentials,
  { accountToken, user, clientInstanceId, preserveCleanupPending = false },
) {
  const next = {
    ...credentials,
    [COMPANION_ACCOUNT_TOKEN_FIELD]: accountToken,
    [COMPANION_ACCOUNT_USER_ID_FIELD]: user.id,
    [COMPANION_ACCOUNT_EMAIL_FIELD]: user.email,
  };
  if (next[COMPANION_CLIENT_INSTANCE_FIELD] !== clientInstanceId) {
    next[COMPANION_CLIENT_INSTANCE_FIELD] = clientInstanceId;
  }
  if (preserveCleanupPending) {
    next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD] = true;
  } else {
    delete next[COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD];
  }
  return next;
}

const FRIENDLY_MESSAGES = Object.freeze({
  invalid_email: "Enter a valid email address.",
  invalid_request: "The secure connection request was not accepted. Check the details and try again.",
  invalid_otp: "That code is not valid. Check the email and try again.",
  otp_expired: "That code expired. Email yourself a new one.",
  unauthorized: "Your sign-in expired. Email yourself a new code to reconnect.",
  forbidden: "The secure connection request was not allowed. Try signing in again.",
  signed_out: "Your sign-in expired. Email yourself a new code to reconnect.",
  network_unavailable: "OpenMausBot could not reach its secure connection service. Check your internet and try again.",
  rate_limited: "Too many attempts were made. Wait a little, then try again.",
  credential_rotation_rate_limited: "This computer was reconnected too often. Wait a little, then try again.",
  installation_limit_reached: "This account has reached its computer limit. Remove an old computer and try again.",
  installation_exists: "This computer is already connected. Try again to recover it.",
  endpoint_busy: "The secure connection is still being prepared. Try again in a moment.",
  endpoint_unavailable: "The secure connection service could not finish setup. Local pairing still works; try again shortly.",
  endpoint_cleanup_pending: "The secure connection is still being removed. Try signing out again shortly.",
  control_plane_unavailable: "Secure access is not available right now. Local pairing still works.",
  internal_error: "The secure connection service had a problem. Local pairing still works; try again.",
  invalid_response: "The secure connection service returned an unexpected response. Try again.",
  request_failed: "The secure connection request could not be completed. Local pairing still works; try again.",
});

export function friendlyCompanionAccountError(error) {
  const code = error instanceof ControlPlaneError ? error.code : "";
  const message = FRIENDLY_MESSAGES[code] ?? FRIENDLY_MESSAGES.request_failed;
  const reference = error instanceof ControlPlaneError && error.requestId
    ? ` Reference: ${error.requestId}.`
    : "";
  return `${message}${reference}`;
}

function publicState({ available, status, email, endpoint, message }) {
  const state = { available: Boolean(available), status };
  const normalizedEmail = normalizeAccountEmail(email);
  if (normalizedEmail) state.email = normalizedEmail;
  const accessEndpoint = (() => {
    if (typeof endpoint !== "string") return "";
    try {
      const parsed = new URL(endpoint);
      return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash
        ? parsed.origin
        : "";
    } catch {
      return "";
    }
  })();
  if (accessEndpoint) state.endpoint = accessEndpoint;
  const safeMessage = typeof message === "string" && message.length >= 1 && message.length <= 280
    ? message
    : null;
  if (safeMessage) state.message = safeMessage;
  return Object.freeze(state);
}

/** Authenticated hosted-Companion orchestration, with all Electron, storage,
 * and network mechanisms injected. Nothing returned by this service can
 * contain an account bearer, installation credential, connector token, or a
 * Cloudflare resource identifier. */
export function createCompanionAccountService({
  client,
  readCredentials,
  updateCredentials,
  identity,
  newClientInstanceId,
  clientInstanceId,
  identityError = "",
  credentialStoreUnavailable = false,
  credentialStoreError = "",
  runtimeProfile = "desktop-hub",
  appVersion = "",
  capabilities = ["companion", "harness"],
  schedulePresence = (work) => setInterval(work, 60_000),
  clearPresence = clearInterval,
  activatePersistedEndpoint = async () => ({ status: "stopped", ready: false }),
  stopManagedEndpoint = async () => {},
  managedConnectionState = () => ({ status: "stopped", ready: false }),
  companionIsOn = () => false,
  now = Date.now,
  healthCacheMs = DEFAULT_HEALTH_CACHE_MS,
} = {}) {
  const configured = Boolean(client);
  const configuredClientInstanceId = clientInstanceId !== undefined
    ? clientInstanceId
    : identity?.clientInstanceId;
  const identityUnavailable = typeof identityError === "string" && identityError.length > 0;
  const storeUnavailable = Boolean(credentialStoreUnavailable);
  const storeUnavailableMessage = typeof credentialStoreError === "string" && credentialStoreError.length > 0
    ? credentialStoreError
    : "The operating-system credential store could not be read this launch";
  const presenceCapabilities = Object.freeze(
    [...new Set(Array.isArray(capabilities) ? capabilities : [])].sort(),
  );
  let healthy = false;
  let lastHealthCheck = null;
  let healthProbe = null;
  let phase = null;
  let transition = Promise.resolve();
  let presenceTimer = null;
  let presenceTimerScheduled = false;
  let presenceActive = false;
  let presenceGeneration = 0;
  let initialPresenceUnavailable = false;
  let disposed = false;
  let disposePromise = null;
  const inFlightPresence = new Set();

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const credentials = () => readCredentials?.() ?? {};

  const requireCredentialStore = () => {
    if (storeUnavailable) throw new Error(storeUnavailableMessage);
  };

  const presenceError = (error, email, generation = presenceGeneration) => {
    if (generation !== presenceGeneration) return;
    if (error instanceof ControlPlaneError && error.status === 401) {
      stopPresence();
      phase = {
        status: "signed-out",
        email,
        message: friendlyCompanionAccountError(error),
      };
    }
  };

  const sendPresence = async (installationCredential, email, generation = presenceGeneration) => {
    if (disposed) return;
    const work = Promise.resolve()
      .then(() => client.updatePresence(installationCredential, {
        runtimeProfile,
        appVersion,
        capabilities: presenceCapabilities,
      }))
      .catch((error) => {
        presenceError(error, email, generation);
        throw error;
      });
    inFlightPresence.add(work);
    try {
      await work;
    } finally {
      inFlightPresence.delete(work);
    }
  };

  const schedulePresenceHeartbeat = (installationCredential, email) => {
    if (disposed) return;
    stopPresence();
    const generation = presenceGeneration;
    presenceActive = true;
    const run = () => {
      if (!presenceActive || disposed || generation !== presenceGeneration) return;
      return sendPresence(installationCredential, email, generation).catch(() => {});
    };
    presenceTimer = schedulePresence(run);
    presenceTimerScheduled = true;
    if (!presenceActive || generation !== presenceGeneration) {
      stopPresence();
    } else {
      presenceTimer?.unref?.();
    }
  };

  function stopPresence() {
    presenceActive = false;
    presenceGeneration += 1;
    if (presenceTimerScheduled) {
      clearPresence(presenceTimer);
      presenceTimer = null;
      presenceTimerScheduled = false;
    }
  }

  const ensurePresence = async (account) => {
    if (!account?.installationCredential || disposed) return;
    stopPresence();
    const generation = presenceGeneration;
    try {
      await sendPresence(account.installationCredential, account.email, generation);
    } catch (error) {
      if (
        !disposed &&
        generation === presenceGeneration &&
        !(error instanceof ControlPlaneError && error.status === 401)
      ) {
        initialPresenceUnavailable = true;
        phase = {
          status: "error",
          email: account.email,
          message: friendlyCompanionAccountError(error),
        };
      }
      throw error;
    }
    initialPresenceUnavailable = false;
    if (!disposed && generation === presenceGeneration && presenceActive === false) {
      schedulePresenceHeartbeat(account.installationCredential, account.email);
    }
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    stopPresence();
    disposePromise = (async () => {
      while (inFlightPresence.size > 0) {
        await Promise.allSettled(inFlightPresence);
      }
    })();
    return disposePromise;
  };

  const probeControlPlane = async ({ force = false } = {}) => {
    if (!configured || storeUnavailable) return false;
    const checkedAt = now();
    if (
      !force &&
      lastHealthCheck !== null &&
      checkedAt - lastHealthCheck < Math.max(0, healthCacheMs)
    ) {
      return healthy;
    }
    if (healthProbe) return healthProbe;
    healthProbe = (async () => {
      try {
        await client.health();
        healthy = true;
      } catch {
        healthy = false;
      }
      lastHealthCheck = now();
      return healthy;
    })().finally(() => {
      healthProbe = null;
    });
    return healthProbe;
  };

  const requireHealthyControlPlane = async () => {
    requireCredentialStore();
    if (!(await probeControlPlane({ force: true }))) {
      throw new ControlPlaneError("control_plane_unavailable");
    }
  };

  const settledState = () => {
    if (identityUnavailable) {
      return publicState({
        available: false,
        status: "error",
        message: identityError,
      });
    }
    if (storeUnavailable) {
      return publicState({
        available: false,
        status: "error",
        message: storeUnavailableMessage,
      });
    }
    if (!configured) {
      return publicState({
        available: false,
        status: "signed-out",
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
      });
    }
    const document = credentials();
    const account = storedAccount(document);
    const persistedAccess = managedCompanionTunnelAccess(document);
    const available = healthy || Boolean(account);
    if (!healthy) {
      return publicState({
        available,
        status: account ? "error" : "signed-out",
        email: account?.email,
        endpoint: persistedAccess?.endpoint,
        message: FRIENDLY_MESSAGES.control_plane_unavailable,
      });
    }
    if (
      phase &&
      ["connecting", "error"].includes(phase.status) &&
      !initialPresenceUnavailable &&
      account &&
      persistedAccess &&
      !companionAccountCleanupPending(document) &&
      managedConnectionState?.()?.ready === true
    ) {
      phase = null;
    }
    if (phase) return publicState({ available, ...phase });
    if (!account) return publicState({ available, status: "signed-out" });
    const access = persistedAccess;
    if (!access) {
      return publicState({
        available,
        status: "error",
        email: account.email,
        message: "This computer still needs a secure address. Try again; local pairing continues to work.",
      });
    }
    const connection = managedConnectionState?.() ?? {};
    if (companionIsOn()) {
      if (["starting", "retrying"].includes(connection.status)) {
        return publicState({
          available,
          status: "connecting",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection is starting. Local pairing remains available.",
        });
      }
      if (["unavailable", "error"].includes(connection.status)) {
        return publicState({
          available,
          status: "error",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection needs attention. Local pairing still works.",
        });
      }
    }
    return publicState({
      available,
      status: "ready",
      email: account.email,
      endpoint: access.endpoint,
    });
  };

  const resolveClientIdentity = () => {
    const current = credentials();
    if (configuredClientInstanceId !== undefined) {
      if (!isValidOpaqueId(configuredClientInstanceId)) {
        throw new ControlPlaneError("invalid_client_identity");
      }
      return configuredClientInstanceId;
    }
    if (Object.hasOwn(current, COMPANION_CLIENT_INSTANCE_FIELD)) {
      const existing = current[COMPANION_CLIENT_INSTANCE_FIELD];
      if (!isValidOpaqueId(existing)) throw new ControlPlaneError("invalid_client_identity");
      return existing;
    }
    const candidate = newClientInstanceId?.();
    if (!isValidOpaqueId(candidate)) throw new Error("A stable computer identity could not be created");
    return candidate;
  };

  const ensureClientIdentity = async () => {
    requireCredentialStore();
    const candidate = resolveClientIdentity();
    const current = credentials();
    if (current[COMPANION_CLIENT_INSTANCE_FIELD] === candidate) return candidate;
    await updateCredentials((document) => {
      return { ...document, [COMPANION_CLIENT_INSTANCE_FIELD]: candidate };
    });
    const persisted = credentials()[COMPANION_CLIENT_INSTANCE_FIELD];
    if (persisted !== candidate) throw new ControlPlaneError("invalid_client_identity");
    return persisted;
  };

  const markCleanupPending = async () => {
    requireCredentialStore();
    await updateCredentials((document) => ({
      ...document,
      [COMPANION_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
    }));
  };

  const clearAfterCleanup = async () => {
    requireCredentialStore();
    await updateCredentials(withoutCompanionAccount);
    await stopManagedEndpoint();
    phase = null;
  };

  /** Returns true only when the installation was revoked (which schedules
   * endpoint cleanup) and it is safe to forget its local retry credentials. */
  const cleanupCurrentAccount = async ({ markPending = true } = {}) => {
    requireCredentialStore();
    stopPresence();
    const document = credentials();
    const account = storedAccount(document);
    if (!account) {
      await clearAfterCleanup();
      return true;
    }
    if (markPending && !companionAccountCleanupPending(document)) await markCleanupPending();
    await stopManagedEndpoint();

    // Deleting first gives immediate feedback. Revocation remains mandatory:
    // it invalidates the installation credential and gives the server a
    // durable cleanup path even if the direct delete failed halfway through.
    if (account.installationCredential) {
      try {
        await client.deleteEndpoint(account.installationCredential);
      } catch {
        // Revocation below is the authoritative cleanup schedule.
      }
    }
    if (!account.accountToken) {
      throw new ControlPlaneError("signed_out", 401);
    }

    // A request can create an installation (and even its endpoint) while its
    // response is lost, leaving no local ID or connector material. The stable
    // stable computer ID is therefore the cleanup authority: list the account's
    // active installations and revoke every matching record before forgetting
    // the bearer. Revocation marks the owner row and durably schedules the
    // server-side endpoint sweep.
    const clientInstanceId = resolveClientIdentity();

    // The known ID is a fast path. Its result is not trusted on its own: the
    // authoritative list below also catches a response-lost duplicate.
    if (account.installationId) {
      await client.revokeInstallation(account.accountToken, account.installationId).catch(() => {});
    }
    const installations = await client.listInstallations(account.accountToken);
    for (const installation of installations) {
      if (
        installation.clientInstanceId !== clientInstanceId &&
        installation.id !== account.installationId
      ) {
        continue;
      }
      try {
        await client.revokeInstallation(account.accountToken, installation.id);
      } catch (error) {
        if (!(error instanceof ControlPlaneError) || error.status !== 404) throw error;
      }
    }
    try {
      await client.signOut(account.accountToken);
    } catch {
      // The installation and connector have already been revoked. A stale
      // Better Auth session expires server-side and must not block local
      // sign-out or retain its bearer on disk.
    }
    await clearAfterCleanup();
    return true;
  };

  const provision = async ({ accountToken, user }) => {
    requireCredentialStore();
    const clientInstanceId = await ensureClientIdentity();
    const before = credentials();
    const previous = storedAccount(before);
    const installation = await client.ensureInstallation({
      accountToken,
      currentCredential:
        previous?.userId === user.id ? previous.installationCredential : "",
      clientInstanceId,
      name: identity.name,
      platform: identity.platform,
      appVersion: identity.appVersion,
    });
    if (
      !INSTALLATION_CREDENTIAL.test(installation?.credential) ||
      !isValidOpaqueId(installation?.installation?.id) ||
      !isValidOpaqueId(installation?.installation?.clientInstanceId) ||
      installation.installation.clientInstanceId !== clientInstanceId
    ) {
      throw new ControlPlaneError("invalid_response");
    }

    const reusedExistingInstallation = Boolean(
      previous?.userId === user.id &&
      previous.installationId === installation.installation.id &&
      previous.installationCredential === installation.credential,
    );
    const rollbackProvisioning = async ({
      endpointProvisioned = false,
      preserveExisting = reusedExistingInstallation,
    } = {}) => {
      stopPresence();
      if (endpointProvisioned) {
        await client.deleteEndpoint(installation.credential).catch(() => {});
      }
      if (!preserveExisting) {
        await client.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      }
    };

    try {
      await ensurePresence({
        installationCredential: installation.credential,
        email: user.email,
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 401) {
        // Keep the returned credential as a recovery hint for the existing
        // no-remint signed-out path. No endpoint is provisioned yet, and the
        // canonical identity remains untouched.
        await updateCredentials((document) => {
          const next = {
            ...document,
            [COMPANION_INSTALLATION_ID_FIELD]: installation.installation.id,
            [COMPANION_INSTALLATION_CREDENTIAL_FIELD]: installation.credential,
          };
          if (Number.isSafeInteger(installation.credentialExpiresAt)) {
            next[COMPANION_INSTALLATION_EXPIRY_FIELD] = installation.credentialExpiresAt;
          } else {
            delete next[COMPANION_INSTALLATION_EXPIRY_FIELD];
          }
          return next;
        }).catch(() => {});
      } else {
        await rollbackProvisioning();
      }
      throw error;
    }

    let endpoint;
    try {
      endpoint = await client.ensureEndpoint(installation.credential);
    } catch (error) {
      await rollbackProvisioning();
      throw error;
    }
    try {
      await updateCredentials((document) =>
        withProvisionedAccount(document, {
          accountToken,
          user,
          installation,
          provision: endpoint,
        }),
      );
    } catch (error) {
      // Persistence failed after remote allocation. Best effort cleanup avoids
      // an invisible tunnel; no secret is ever written to a log or exception.
      await rollbackProvisioning({ endpointProvisioned: true });
      throw error;
    }
    const connection = await activatePersistedEndpoint();
    phase = null;
    if (
      companionIsOn() &&
      connection &&
      ["unavailable", "error"].includes(connection.status)
    ) {
      phase = {
        status: "error",
        email: user.email,
        endpoint: endpoint.endpoint.url,
        message: "The address is ready, but this app could not start its secure connection. Local pairing still works.",
      };
    }
    return settledState();
  };

  const failAction = (
    error,
    { email, expiredSessionIsSignedOut = false, signedOut = false } = {},
  ) => {
    const message = friendlyCompanionAccountError(error);
    phase = {
      status:
        signedOut ||
        (expiredSessionIsSignedOut && error instanceof ControlPlaneError && error.status === 401)
          ? "signed-out"
          : "error",
      email,
      message,
    };
    return message;
  };

  const requestCode = (rawEmail) => serialize(async () => {
    requireCredentialStore();
    if (identityUnavailable) throw new Error(identityError);
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    let requested;
    try {
      await requireHealthyControlPlane();
      requested = await client.requestOTP(email);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }
    phase = {
      status: "signed-out",
      email: requested.email,
    };
    return settledState();
  });

  const verifyCode = (rawEmail, rawCode) => serialize(async () => {
    requireCredentialStore();
    if (identityUnavailable) throw new Error(identityError);
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    phase = { status: "connecting", email };
    let verified;
    try {
      await requireHealthyControlPlane();
      verified = await client.verifyOTP(email, rawCode);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }

    const previous = storedAccount(credentials());
    const refreshingPendingCleanup = Boolean(
      previous &&
      previous.userId === verified.user.id &&
      companionAccountCleanupPending(credentials()),
    );
    let authenticatedPersisted = false;
    try {
      if (previous && previous.userId !== verified.user.id) {
        await cleanupCurrentAccount();
      }
      const clientInstanceId = resolveClientIdentity();
      await updateCredentials((document) =>
        withAuthenticatedAccount(document, {
          ...verified,
          clientInstanceId,
          preserveCleanupPending: refreshingPendingCleanup,
        }),
      );
      authenticatedPersisted = true;
      if (refreshingPendingCleanup) {
        // The user supplied a fresh bearer to finish an interrupted sign-out.
        // Keep that intent and retry revocation; do not silently turn the
        // sign-out action into a new endpoint provisioning operation.
        await cleanupCurrentAccount({ markPending: false });
        return settledState();
      }
      return await provision(verified);
    } catch (error) {
      if (!authenticatedPersisted) await client.signOut(verified.accountToken).catch(() => {});
      failAction(error, {
        email: authenticatedPersisted ? verified.user.email : previous?.email ?? email,
        expiredSessionIsSignedOut: authenticatedPersisted,
      });
      return settledState();
    }
  });

  const retryWork = async () => {
    if (storeUnavailable) return settledState();
    requireCredentialStore();
    if (identityUnavailable) return settledState();
    if (!configured) return settledState();
    const account = storedAccount(credentials());
    if (!account) {
      phase = null;
      return settledState();
    }
    if (companionAccountCleanupPending(credentials())) {
      phase = { status: "connecting", email: account.email };
      try {
        await requireHealthyControlPlane();
        await cleanupCurrentAccount({ markPending: false });
      } catch (error) {
        failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      }
      return settledState();
    }
    phase = { status: "connecting", email: account.email };
    try {
      await requireHealthyControlPlane();
      return await provision({
        accountToken: account.accountToken,
        user: { id: account.userId, email: account.email },
      });
    } catch (error) {
      failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      return settledState();
    }
  };

  const retry = () => serialize(retryWork);

  const signOut = () => serialize(async () => {
    if (storeUnavailable) return settledState();
    requireCredentialStore();
    stopPresence();
    if (identityUnavailable) throw new Error(identityError);
    if (!storedAccount(credentials())) {
      await clearAfterCleanup();
      return settledState();
    }
    const email = storedAccount(credentials())?.email;
    phase = { status: "connecting", email };
    try {
      // Local access must stop even when the hosted control plane is down.
      // cleanupCurrentAccount first persists durable cleanup intent and stops
      // the connector, then attempts remote deletion/revocation with the
      // retained credentials. A failed remote step is retryable; a health
      // preflight here would leave paired-phone access live after Sign out.
      await cleanupCurrentAccount();
      // Successful owner-scoped reconciliation is stronger evidence than a
      // separate health probe and keeps the signed-out setup card available.
      healthy = true;
      lastHealthCheck = now();
      return settledState();
    } catch (error) {
      failAction(error, { email });
      return settledState();
    }
  });

  const restore = () => serialize(async () => {
    if (storeUnavailable) return settledState();
    requireCredentialStore();
    if (identityUnavailable) return settledState();
    if (!configured) return settledState();
    if (!(await probeControlPlane({ force: true }))) return settledState();
    if (companionAccountCleanupPending(credentials())) return retryWork();
    await ensureClientIdentity();
    const account = storedAccount(credentials());
    if (account && !managedCompanionTunnelAccess(credentials())) return retryWork();
    if (account) {
      try {
        await ensurePresence(account);
      } catch (error) {
        presenceError(error, account.email);
      }
    }
    if (phase?.status !== "signed-out" && !initialPresenceUnavailable) phase = null;
    return settledState();
  });

  return Object.freeze({
    state: async () => {
      if (storeUnavailable) return settledState();
      await transition;
      await probeControlPlane();
      return settledState();
    },
    requestCode,
    verifyCode,
    retry,
    signOut,
    restore,
    stopPresence,
    dispose,
  });
}
