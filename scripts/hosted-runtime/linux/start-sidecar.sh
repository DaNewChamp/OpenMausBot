#!/bin/bash
set -euo pipefail

RUNTIME_ROOT="${OMB_RUNTIME_ROOT:-/opt/openmausbot/runtime}"
ORIGIN_DIR="${OMB_ORIGIN_DIR:-/var/lib/openmausbot/omb-hosted/omb-companion-origin-main}"
SOCK="${OMB_COMPANION_INTERNAL_ORIGIN:-$ORIGIN_DIR/origin.sock}"

mkdir -p "$(dirname "$SOCK")"
rm -f "$SOCK"

export OMB_PORT="${OMB_PORT:-8799}"
export OMB_WEBHOOK_PORT="${OMB_WEBHOOK_PORT:-8800}"
export OMB_COMPANION_PORT="${OMB_COMPANION_PORT:-28810}"
export OMB_CONTROL_PORT="${OMB_CONTROL_PORT:-28811}"
export OMB_COMPANION_INTERNAL_ORIGIN="$SOCK"
export OMB_COMPANION_HOSTED_URL="${OMB_COMPANION_HOSTED_URL:-https://openmaus.posival.com}"
export OMB_COMPANION_DIR="${OMB_COMPANION_DIR:-/var/lib/openmausbot-companion}"
export OMB_RUNTIME_ROOT="$RUNTIME_ROOT"
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

exec /usr/bin/node "$RUNTIME_ROOT/companion/index.js"
