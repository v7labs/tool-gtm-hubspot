#!/usr/bin/env bash
# Post-sync Obsidian CLI checks for Capital Dynamics pilot (tool-gtm-vault).
set -euo pipefail

VAULT="${OBSIDIAN_VAULT_NAME:-tool-gtm-vault}"
COMPANY_ID="${1:-29053398081}"

echo "=== Obsidian smoke: vault=${VAULT} company=${COMPANY_ID} ==="

run() {
  echo "+ $*"
  "$@" || true
}

run obsidian vault="$VAULT" search query="primary_company_id:${COMPANY_ID}" total

run obsidian vault="$VAULT" backlinks file="Brief" path="GTM/Deals"

run obsidian vault="$VAULT" search query="type:deal_brief motion:" total

run obsidian vault="$VAULT" search query="tag:gtm/capital-dynamics type:gong_call" total

run obsidian vault="$VAULT" read path="GTM/Accounts/${COMPANY_ID} Capital Dynamics/Account.md"

echo "=== Manual: open each Brief and confirm wikilinks ≤ 8 ==="
