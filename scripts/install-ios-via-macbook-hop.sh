#!/usr/bin/env bash
# Run on the Mac mini. Signs on the mini, installs on the phone via MacBook.
# Do NOT SSH xcodebuild to the MacBook — codesign fails headlessly (Share appex).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${BRANCH:-cursor/build-36-local-vm-phone-a27c}"
DEVICE_UDID="${DEVICE_UDID:-C8EA9F61-6E1A-5C41-A4DE-B3454CC89528}"

echo "==> Mac mini → iPhone (branch $BRANCH, device $DEVICE_UDID)"
echo "    archive/sign on mini, devicectl install on MacBook"

cd "$ROOT"
if git remote | grep -qx personal; then
  git fetch personal "$BRANCH"
  git checkout "$BRANCH" 2>/dev/null || git checkout -B "$BRANCH" "personal/$BRANCH"
  git reset --hard "personal/$BRANCH"
fi

exec env DEVICE_UDID="$DEVICE_UDID" "$ROOT/scripts/push-ios-wifi-release.sh"
