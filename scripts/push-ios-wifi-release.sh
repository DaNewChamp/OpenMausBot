#!/usr/bin/env bash
# Archive a Release build, export for development install, push to iPhone over WiFi.
# Use when TestFlight upload is blocked (ASC error 90382) or you need the phone now.
#
# Typical flow: run on the Mac mini (signing works with the ASC API key), install
# via the MacBook (phone is paired there over WiFi). See ios/AppStore/RELEASE.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS="$ROOT/ios"
BRANCH="${BRANCH:-cursor/build-36-local-vm-phone-a27c}"
ARCHIVE="${ARCHIVE:-$ROOT/build/OpenMausCompanion-wifi.xcarchive}"
EXPORT="${EXPORT:-$ROOT/build/export-wifi}"
AUTH_KEY="${AUTH_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_2RY648NNC3.p8}"
AUTH_KEY_ID="${AUTH_KEY_ID:-2RY648NNC3}"
AUTH_ISSUER_ID="${AUTH_ISSUER_ID:-e2e0f91b-e7f8-4585-9b12-700e801bae4d}"
MACBOOK_USER="${MACBOOK_USER:-vincent}"
MACBOOK_HOST="${MACBOOK_HOST:-vincents.macbook.pro.lan}"
MACBOOK_HOST_FALLBACK="${MACBOOK_HOST_FALLBACK:-192.168.112.99}"
DEVICE_UDID="${DEVICE_UDID:-C8EA9F61-6E1A-5C41-A4DE-B3454CC89528}"
BUNDLE_ID="com.posival.openmausmobile"
STAGING="/tmp/OpenMausCompanion.app"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

if [[ -d "$ROOT/.git" ]] && git remote | grep -qx personal; then
  git -C "$ROOT" fetch personal "$BRANCH"
  git -C "$ROOT" checkout "$BRANCH" 2>/dev/null || git -C "$ROOT" checkout -B "$BRANCH" "personal/$BRANCH"
  git -C "$ROOT" reset --hard "personal/$BRANCH"
fi

rm -rf "$EXPORT" "$ARCHIVE"
cd "$IOS" && xcodegen generate

echo "==> Archive (Release)..."
xcodebuild \
  -project OpenMausCompanion.xcodeproj \
  -scheme OpenMausCompanion \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM=LT58RNRW7E \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_ISSUER_ID" \
  -allowProvisioningUpdates \
  archive

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleVersion' "$ARCHIVE/Info.plist")"
echo "==> Export development (build $VERSION)..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$IOS/ExportOptions-development.plist" \
  -authenticationKeyPath "$AUTH_KEY" \
  -authenticationKeyID "$AUTH_KEY_ID" \
  -authenticationKeyIssuerID "$AUTH_ISSUER_ID" \
  -allowProvisioningUpdates

UNZIP="$(mktemp -d)"
trap 'rm -rf "$UNZIP"' EXIT
unzip -q "$EXPORT/OpenMausCompanion.ipa" -d "$UNZIP"
APP="$UNZIP/Payload/OpenMausCompanion.app"
/usr/libexec/PlistBuddy -c "Print :NSExtension:NSExtensionPointIdentifier" \
  "$APP/PlugIns/OpenMausCompanionShare.appex/Info.plist" >/dev/null

echo "==> Copy to MacBook and install over WiFi..."
install_via_macbook() {
  local host="$1"
  rsync -az "$APP/" "${MACBOOK_USER}@${host}:${STAGING}/"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "${MACBOOK_USER}@${host}" \
    "xcrun devicectl device install app --device '$DEVICE_UDID' '$STAGING' && \
     xcrun devicectl device process launch --device '$DEVICE_UDID' '$BUNDLE_ID'"
}

if install_via_macbook "$MACBOOK_HOST"; then
  echo "==> Done — V Bot build $VERSION installed on $DEVICE_UDID"
  exit 0
fi

echo "==> Primary MacBook host failed ($MACBOOK_HOST), trying ${MACBOOK_HOST_FALLBACK}..." >&2
install_via_macbook "$MACBOOK_HOST_FALLBACK"
echo "==> Done — V Bot build $VERSION installed on $DEVICE_UDID"
