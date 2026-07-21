# Archived — moved into tool-gtm-vault

This repository is **archived**. Canonical HubSpot → vault sync now lives in:

**https://github.com/v7labs/tool-gtm-vault** → `packages/hubspot/`

```bash
cd ~/Projects/tool-gtm-vault/packages/hubspot
npm install
npm run sync-deal-map -- <dealId>
```

Do not open PRs here. Local clone may remain for `.env.local`; prefer copying secrets into the vault nested package.
