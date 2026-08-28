#!/usr/bin/env bash
# Build Debug OpenMausCompanion and install to a paired iPhone via devicectl.
# Run on a Mac with Xcode — typically the MacBook while the phone is on Wi‑Fi/USB.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/ios"
SCHEME="OpenMausCompanion"
BUNDLE_ID="com.posival.openmausmobile"
TEAM_ID="LT58RNRW7E"
# xcodebuild wants the USB/WiFi device id; devicectl wants the CoreDevice UUID.
XCODE_DEVICE_ID="${XCODE_DEVICE_ID:-00008150-001428C00247801C}"
DEVICE_UDID="${DEVICE_UDID:-C8EA9F61-6E1A-5C41-A4DE-B3454CC89528}"
BRANCH="${BRANCH:-cursor/build-36-local-vm-phone-a27c}"
DERIVED="$IOS/build/DerivedData-device"
AUTH_KEY="${AUTH_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_2RY648NNC3.p8}"
AUTH_KEY_ID="${AUTH_KEY_ID:-2RY648NNC3}"
AUTH_ISSUER_ID="${AUTH_ISSUER_ID:-e2e0f91b-e7f8-4585-9b12-700e801bae4d}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

echo "==> OpenMausBot iOS device install"
echo "    branch: $BRANCH"
echo "    xcode device: $XCODE_DEVICE_ID"
echo "    devicectl device: $DEVICE_UDID"

cd "$ROOT"
if [[ -d .git ]]; then
  if git remote | grep -qx personal; then
    git fetch personal "$BRANCH" 2>/dev/null || true
    git checkout "$BRANCH" 2>/dev/null || git checkout -B "$BRANCH" "personal/$BRANCH"
    git pull --ff-only "personal/$BRANCH" 2>/dev/null || git reset --hard "personal/$BRANCH"
  else
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull --ff-only origin "$BRANCH" || true
  fi
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
  -destination "id=$XCODE_DEVICE_ID" \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_ISSUER_ID" \
  -allowProvisioningUpdates \
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
