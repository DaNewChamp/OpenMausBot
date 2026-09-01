# TestFlight and App Store release

The app is native Swift and uses XcodeGen; EAS commands do not apply. The private product name is
**V Bot**. Keep the existing bundle identifiers (`com.posival.openmausmobile`, `.widgets`, and
`.share`) so current TestFlight installs, Keychain pairing, widgets, and share handoff continue to
work; renaming the display name does not require a bundle-ID migration.

## Current release state

- Current iOS project version: **73** (`MARKETING_VERSION` `1.0.0`, `CURRENT_PROJECT_VERSION` `73`).
- Build 73 is recorded as `VALID / IN_BETA_TESTING` in the internal TestFlight lane; external build state is `READY_FOR_BETA_SUBMISSION`.
- What-to-Test for `en-US` was updated for build 73.
- This file does not claim physical-device QA, production deployment, external beta submission, or desktop publication.

## One-time Apple setup

1. Enrol in the Apple Developer Program.
2. Register the bundle IDs `com.posival.openmausmobile`, `com.posival.openmausmobile.widgets`, and `com.posival.openmausmobile.share` (already declared in `project.yml`).
3. Create or use the matching App Store Connect app with the display name **V Bot**, primary category **Productivity**, and a unique SKU. Preserve upstream OpenMausBot attribution in the review metadata.
4. Create or select an Apple Distribution certificate and App Store provisioning profile.
5. Add the review contact details in App Store Connect; do not commit private contact data or App Store Connect keys.

## Before every upload

1. Run `swift test` from `ios/` and the repository test suite.
2. Generate the Xcode project with `xcodegen generate` from `ios/`.
3. Set `DEVELOPMENT_TEAM` for the Release configuration in Xcode or on the archive command line.
4. Increment `CURRENT_PROJECT_VERSION` from 74 for every new upload. Update `MARKETING_VERSION` only for a new App Store version.
5. Archive a generic iOS device build and validate it in Xcode Organizer.
6. Upload to App Store Connect and distribute to internal TestFlight testers first.
7. Complete a real-iPhone pass for pairing, Bonjour permission, Keychain restore, Tailscale, optional hosted HTTPS, approvals, background/foreground reconciliation, sign-out/revocation, transcript sharing, attachments, and Local VM/watch paths.
8. After internal testing, submit to an external TestFlight group before App Review.

## App Store Connect

- Copy the localized text from `en-US/`.
- Use `privacy-answers.md` and verify it still matches the binary.
- Use `review-notes.md`, adding a real review contact in App Store Connect.
- Support URL: `https://github.com/milind-soni/OpenMausBot/issues`
- Privacy policy URL: `https://github.com/milind-soni/OpenMausBot/blob/main/docs/ios-privacy.md`
- Choose manual release for 1.0; enable a phased release after the first production build is stable.

The unsigned simulator CI proves compilation, not distribution signing. A TestFlight upload cannot be automated until the Apple team, App Store Connect record, and protected signing/API-key secrets exist.

## WiFi install when TestFlight is unavailable

Use this when App Store Connect rejects upload (**error 90382** — daily upload limit), processing is slow, or you need the build on a physical iPhone immediately. This is **not** TestFlight: it installs a development-signed build over the network using `devicectl`.

### Prerequisites

- iPhone and MacBook on the **same Wi‑Fi**, phone **paired** in Xcode (Wireless debugging on).
- ASC API key at `~/.appstoreconnect/private_keys/AuthKey_2RY648NNC3.p8` (same key as TestFlight archive/upload).
- `brew install xcodegen` on the machine that archives.
- Hosted server changes still deploy separately: `bun run deploy:hosted-runtime` on the Mac mini when the branch touches `server/` or `companion/`.

### Find your device ids (they differ)

| Tool | Example | Command |
|---|---|---|
| `xcodebuild -destination id=…` | `00008150-001428C00247801C` | `xcrun xctrace list devices` |
| `devicectl device install` | `C8EA9F61-6E1A-5C41-A4DE-B3454CC89528` | `xcrun devicectl list devices` |

Export `XCODE_DEVICE_ID` and `DEVICE_UDID` if Vincent's phone is not the default in `scripts/install-ios-device.sh`.

### One command (MacBook or Mac mini)

```sh
cd ~/Github/OpenMausBot
./scripts/install-ios-now.sh
```

- **MacBook** (phone paired here): Debug build + install locally in Terminal.
- **Mac mini** (phone on MacBook Wi‑Fi): Release archive/sign on mini, copy to MacBook, `devicectl` install. Avoids SSH `xcodebuild` codesign failures.

### Path A — MacBook only (Debug, fastest loop)

Run **locally in Terminal.app on the MacBook**, not over SSH — remote `xcodebuild` codesign often fails with `errSecInternalComponent` even with the ASC API key.

```sh
cd ~/Github/OpenMausBot
./scripts/install-ios-device.sh
```

Builds the selected branch (default current checkout), installs and launches via `devicectl`. Set `BRANCH=…` only when intentionally testing an older or isolated branch; do not use the historical `personal/cursor/build-36-local-vm-phone-a27c` branch as a release source.

### Path B — Mac mini archives, MacBook installs (Release, most reliable for agents)

Signing works headlessly on the mini with the ASC API key. The phone is only visible to the MacBook, so export a development build on the mini and install from the MacBook:

```sh
cd ~/Github/OpenMausBot
./scripts/push-ios-wifi-release.sh
```

Or manually: `xcodegen generate` → Release `archive` → export with `ios/ExportOptions-development.plist` → unzip the `.ipa` → `rsync` the `.app` to the MacBook → `devicectl device install app`.

From the Mac mini when you only need to trigger the MacBook Debug path:

```sh
./scripts/install-ios-via-macbook-hop.sh
```

(Same as `./scripts/install-ios-now.sh` on the mini — archives here, installs via MacBook. Does **not** SSH `xcodebuild` to the MacBook.)

### Path C — TestFlight archive without upload

If the upload limit is the only blocker, keep the `.xcarchive` under `build/` and retry `xcodebuild -exportArchive` with `ios/ExportOptions.plist` (`destination: upload`) the next day. Do not rebuild unless source changed.

### Gotchas

- **`xcodegen generate` strips bare Share-extension keys** from `ios/Share/Info.plist`. NSExtension metadata must live under `OpenMausCompanionShare.info.properties` in `ios/project.yml` or device install fails with `AppexBundleMissingNSExtensionDict`.
- **Release compile**: if `ComputerView.swift` times out in `-O`, extract heavy `.task` bodies into private methods (see commit `9de7756`).
- **Wrong destination id** makes `xcodebuild` list simulators only — use the `xctrace` id for build, the `devicectl` UUID for install.
- WiFi install replaces the app at `com.posival.openmausmobile`; delete and reinstall if icon/notification cache looks stale after a branding change.
