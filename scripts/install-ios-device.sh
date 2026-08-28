#!/usr/bin/env bash
# Build Debug OpenMausCompanion and install to a paired iPhone via devicectl.
# Run on a Mac with Xcode — typically the MacBook while the phone is on Wi‑Fi/USB.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/ios"
SCHEME="OpenMausCompanion"
BUNDLE_ID="com.posival.openmausmobile"
TEAM_ID="LT58RNRW7E"
DEVICE_UDID="${DEVICE_UDID:-00008150-001428C00247801C}"
BRANCH="${BRANCH:-cursor/build-36-local-vm-phone-a27c}"
DERIVED="$IOS/build/DerivedData-device"

echo "==> OpenMausBot iOS device install"
echo "    branch: $BRANCH"
echo "    device: $DEVICE_UDID"

cd "$ROOT"
if [[ -d .git ]]; then
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH" || true
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found — install with: brew install xcodegen" >&2
  exit 1
fi

cd "$IOS"
xcodegen generate

echo "==> Building Debug for device…"
xcodebuild \
  -project OpenMausCompanion.xcodeproj \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$DEVICE_UDID" \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  build

APP="$(find "$DERIVED" -path '*/Build/Products/Debug-iphoneos/OpenMausCompanion.app' -print -quit)"
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "Built .app not found under $DERIVED" >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Info.plist")"
echo "==> Installing build $VERSION from $APP"

xcrun devicectl device install app --device "$DEVICE_UDID" "$APP"
xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID"

echo "==> Done — V Bot build $VERSION launched on device $DEVICE_UDID"
