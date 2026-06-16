# tool-gtm-hubspot

MCP server that syncs HubSpot CRM into the GTM Obsidian vault (`tool-gtm-vault`). Writes deal briefs, engagements, email threads, and association graphs as markdown with `source: hubspot`.

Used by Hermes and GTM workflows that need live CRM context in the knowledge graph. Does not pull Gong transcripts — that is `tool-gtm-gong`.

```bash
npm install && npm run build
```

See `.env.example` for HubSpot + vault paths. Deal sync: `npm run sync-deal-map -- <dealId>`.
