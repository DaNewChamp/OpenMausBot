# Releasing

One workflow builds everything: **Actions → Release → Run workflow**. It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit and verifies every artifact the way a user would
receive it. Artifacts are named `VBot-*` and staged in the private release
repository. The desktop updater remains disabled until `VBOT_UPDATE_FEED_URL`
is explicitly configured to a private HTTPS generic feed.

The workflow refuses to overwrite an already-published version, so the only
prerequisite per release is that `package.json`'s version is bumped on the
ref you run it against.

## Why the gates exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft. Don't remove a gate without reading the comment
above it.

## One-time setup: four secrets

Set these in **V Bot → Settings → Secrets and variables → Actions**.

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

The Developer ID Application certificate, exported from the Mac that
currently signs releases:

```sh
# Keychain Access → My Certificates → "Developer ID Application: Milind Soni
# (993D98NH4J)" → right-click → Export… → .p12 with a strong password, then:
base64 -i DeveloperID.p12 | pbcopy   # → MAC_CERT_P12_BASE64
# the export password             → MAC_CERT_PASSWORD
```

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

### 3. `RELEASES_PAT` (private channel only)

A fine-grained personal access token that lets the workflow write to the
separate private releases repo: **GitHub → Settings → Developer settings →
Fine-grained tokens** → repository access: only the V Bot releases repo →
permissions: **Contents: Read and write**. Set a long expiry and a calendar
reminder.

### Local fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac`, gate with `codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, and regenerate blockmaps.
Upload the `VBot-*` artifacts to the private channel only after review. If
you deliberately operate a generic feed, generate its metadata from the
post-staple bytes and verify the published bytes against that feed.

### Update feed contract

The package config deliberately has `publish: []`, so no GitHub provider or
feed URL is baked into a desktop artifact. A packaging lane may include an
`app-update.yml` only when it contains `provider: generic` and an explicit
HTTPS URL without credentials, ports, query strings, or fragments. The
workflow rejects GitHub/OpenMausBot feed URLs and unsigned `publisherName`
metadata. At runtime, `VBOT_UPDATE_FEED_URL` is the only opt-in and is
validated again by the app before `electron-updater` is started.
