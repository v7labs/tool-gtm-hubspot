#!/usr/bin/env bash
# Run vault_sync_deal_map logic, then commit and push the Obsidian vault.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: sync-deal-map-and-push.sh <dealId> [commit message]" >&2
  exit 1
fi

DEAL_ID="$1"
MESSAGE="${2:-sync(vault): HubSpot deal map ${DEAL_ID}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUBSPOT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VAULT_ROOT="${OBSIDIAN_VAULT_PATH:-/Users/franciscoterpolilli/Projects/tool-gtm-vault}"

export PATH="${HOME}/.local/bin:${PATH}"

cd "$HUBSPOT_ROOT"
npx tsx scripts/sync-deal-map.ts "$DEAL_ID"

"$VAULT_ROOT/scripts/vault-git-push.sh" "$MESSAGE"
