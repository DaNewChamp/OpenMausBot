#!/usr/bin/env bash
# Run on the Mac mini (or via Mac Projects MCP run_shell). SSHs to the MacBook,
# pulls the branch, builds, and installs to the paired iPhone with devicectl.
set -euo pipefail

MACBOOK_USER="${MACBOOK_USER:-vincent}"
# Prefer MagicDNS; Wi‑Fi fallback if Bonjour fails. Avoid stale ~/.ssh/config
# Host macbook entries that still point at dead ethernet (192.168.112.215).
MACBOOK_HOST="${MACBOOK_HOST:-vincents.macbook.pro.lan}"
MACBOOK_HOST_FALLBACK="${MACBOOK_HOST_FALLBACK:-192.168.112.99}"
REPO="${MACBOOK_REPO:-~/Github/OpenMausBot}"
BRANCH="${BRANCH:-cursor/build-36-local-vm-phone-a27c}"
DEVICE_UDID="${DEVICE_UDID:-C8EA9F61-6E1A-5C41-A4DE-B3454CC89528}"

REMOTE_ENV='export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
REMOTE_ENV+=' DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer'

run_on_macbook() {
  local host="$1"
  ssh -o BatchMode=yes -o ConnectTimeout=15 "${MACBOOK_USER}@${host}" \
    "$REMOTE_ENV; cd $REPO && git fetch personal $BRANCH 2>/dev/null || git fetch origin $BRANCH; git checkout $BRANCH 2>/dev/null || git checkout -B $BRANCH personal/$BRANCH; git reset --hard personal/$BRANCH 2>/dev/null || git pull --ff-only origin $BRANCH; DEVICE_UDID=$DEVICE_UDID BRANCH=$BRANCH ./scripts/install-ios-device.sh"
}

echo "==> Mac mini → MacBook iOS install (branch $BRANCH, device $DEVICE_UDID)"

if run_on_macbook "$MACBOOK_HOST"; then
  exit 0
fi

echo "==> Primary host failed ($MACBOOK_HOST), trying $MACBOOK_HOST_FALLBACK…" >&2
run_on_macbook "$MACBOOK_HOST_FALLBACK"
