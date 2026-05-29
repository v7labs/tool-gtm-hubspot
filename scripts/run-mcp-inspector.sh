#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env.local"
set +a

# Avoid split UI/proxy from overlapping starts (6274 = client, 6277 = proxy)
if lsof -nP -iTCP:6274 -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:6277 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stopping existing MCP Inspector on 6274/6277..."
  pkill -f "@modelcontextprotocol/inspector" 2>/dev/null || true
  sleep 1
  if lsof -nP -iTCP:6274 -sTCP:LISTEN >/dev/null 2>&1 || lsof -nP -iTCP:6277 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Ports still in use. Run: pkill -9 -f '@modelcontextprotocol/inspector'" >&2
    exit 1
  fi
fi

echo "HubSpot MCP Inspector"
echo "====================="
echo "1. Browser opens at http://localhost:6274"
echo "2. Transport: Streamable HTTP"
echo "3. URL: https://mcp.hubspot.com/"
echo "4. Client ID: (from .env.local HUBSPOT_MCP_CLIENT_ID)"
echo "5. Client secret: (from .env.local HUBSPOT_MCP_CLIENT_SECRET)"
echo "6. Open Auth Settings → Guided OAuth Flow → complete HubSpot login"
echo "7. Connect → Tools → List Tools → run get_user_details"
echo ""

exec npx @modelcontextprotocol/inspector
