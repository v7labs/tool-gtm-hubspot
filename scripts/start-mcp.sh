#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env.local"
set +a

export HUBSPOT_ACCESS_TOKEN="${HUBSPOT_ACCESS_TOKEN:-${HUBSPOT_SERVICE_KEY:-}}"
export OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH:-/Users/franciscoterpolilli/Projects/tool-gtm-vault}"

exec node "$ROOT/dist/index.js"
