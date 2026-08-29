#!/usr/bin/env bash
# Smoke-check that the Mac Projects MCP tunnel is reachable from a Cloud Agent VM.
# Exit 0 when the endpoint responds (401 without auth is expected and healthy).
set -euo pipefail

URL="${MAC_MINI_MCP_URL:-https://local.posival.com/mcp}"
PRM_URL="${MAC_MINI_MCP_PRM_URL:-https://local.posival.com/.well-known/oauth-protected-resource}"

echo "==> Probing Mac Projects MCP at $URL"

code="$(curl -sS -o /tmp/mac-mini-mcp-body.txt -w '%{http_code}' "$URL" || true)"
echo "    HTTP $code"

case "$code" in
  401)
    echo "    OK: tunnel live, OAuth required (expected without token)"
    ;;
  200)
    echo "    OK: tunnel live and unauthenticated (unexpected for primary profile)"
    ;;
  *)
    echo "    FAIL: unexpected status from $URL" >&2
    head -c 500 /tmp/mac-mini-mcp-body.txt >&2 || true
    echo >&2
    exit 1
    ;;
esac

echo "==> Checking OAuth protected-resource metadata at $PRM_URL"
curl -sS "$PRM_URL" | python3 -m json.tool

echo "==> Mac mini MCP tunnel looks reachable from this environment."
