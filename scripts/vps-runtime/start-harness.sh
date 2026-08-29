#!/bin/bash
set -euo pipefail

RUNTIME_ROOT="${OMB_RUNTIME_ROOT:-/opt/openmausbot/runtime}"
RESOURCES="${OMB_RESOURCES_PATH:-$RUNTIME_ROOT/resources}"
HOME_DIR="${HOME:-/root}"

export OMB_PORT="${OMB_PORT:-8799}"
export OMB_RESOURCES_PATH="$RESOURCES"
export OMB_SKILLS_DIR="${OMB_SKILLS_DIR:-$RESOURCES/skills}"
export OMB_USER_DATA="${OMB_USER_DATA:-/var/lib/openmausbot}"
# Agent CLIs (codex, cursor-agent, claude) install to ~/.local/bin by default.
export PATH="${HOME_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

exec /usr/bin/node "$RUNTIME_ROOT/server/index.js"
