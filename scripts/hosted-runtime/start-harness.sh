#!/bin/zsh
set -euo pipefail

RUNTIME_ROOT="${OMB_RUNTIME_ROOT:-$HOME/Library/Application Support/OpenMausBotHostedCompanion/runtime}"
RESOURCES="${OMB_RESOURCES_PATH:-$RUNTIME_ROOT/resources}"

export OMB_PORT="${OMB_PORT:-8799}"
export OMB_RESOURCES_PATH="$RESOURCES"
export OMB_SKILLS_DIR="${OMB_SKILLS_DIR:-$RESOURCES/skills}"
export OMB_USER_DATA="${OMB_USER_DATA:-$HOME/Library/Application Support/OpenMausBot}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

exec /opt/homebrew/bin/node "$RUNTIME_ROOT/server/index.js"
