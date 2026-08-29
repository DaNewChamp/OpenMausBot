#!/usr/bin/env bash
# One command to get the current branch onto Vincent's iPhone.
# Run on the MacBook OR the Mac mini — picks the path that actually works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${BRANCH:-cursor/build-36-local-vm-phone-a27c}"
DEVICE_UDID="${DEVICE_UDID:-C8EA9F61-6E1A-5C41-A4DE-B3454CC89528}"

cd "$ROOT"

sync_branch() {
  if [[ ! -d .git ]]; then
    return 0
  fi
  if git remote | grep -qx personal; then
    git fetch personal "$BRANCH"
    git checkout "$BRANCH" 2>/dev/null || git checkout -B "$BRANCH" "personal/$BRANCH"
    git reset --hard "personal/$BRANCH"
  else
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git reset --hard "origin/$BRANCH"
  fi
}

phone_visible_here() {
  xcrun devicectl list devices 2>/dev/null | grep -q "$DEVICE_UDID"
}

sync_branch

if phone_visible_here; then
  echo "==> iPhone paired to this Mac — building Debug and installing locally"
  exec env DEVICE_UDID="$DEVICE_UDID" BRANCH="$BRANCH" "$ROOT/scripts/install-ios-device.sh"
fi

echo "==> iPhone not on this Mac — archive + sign here, install via MacBook (Wi‑Fi)"
exec env DEVICE_UDID="$DEVICE_UDID" "$ROOT/scripts/push-ios-wifi-release.sh"
