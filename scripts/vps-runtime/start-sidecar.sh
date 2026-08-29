#!/bin/bash
set -euo pipefail

RUNTIME_ROOT="${OMB_RUNTIME_ROOT:-/opt/openmausbot/runtime}"
ORIGIN_DIR="${OMB_ORIGIN_DIR:-/var/lib/openmausbot/omb-hosted/omb-companion-origin-main}"
HOME_DIR="${HOME:-/root}"

export OMB_RUNTIME_ROOT="$RUNTIME_ROOT"
export OMB_COMPANION_DIR="${OMB_COMPANION_DIR:-/var/lib/openmausbot-companion}"
export OMB_COMPANION_HOSTED_URL="${OMB_COMPANION_HOSTED_URL:-https://openmaus.posival.com}"
export OMB_COMPANION_PORT="${OMB_COMPANION_PORT:-28810}"
export OMB_CONTROL_PORT="${OMB_CONTROL_PORT:-28811}"
export OMB_ORIGIN_DIR="$ORIGIN_DIR"
export PATH="${HOME_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SOCK="$ORIGIN_DIR/origin.sock"
mkdir -p "$ORIGIN_DIR"
rm -f "$SOCK"

exec /usr/bin/node "$RUNTIME_ROOT/companion/index.js"
