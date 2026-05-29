import { join } from "node:path";
import {
  ensureVaultNoteIfMissing,
  formatIsoTimestamp,
  sanitizeFilename,
  wikilink,
} from "./writer.js";

export function hermesLearningsTitle(dealName: string): string {
  return `${dealName} — Hermes Learnings`;
}

export function hermesLearningsRelativePath(dealFolder: string, dealName: string): string {
  return `${dealFolder}/hermes/${sanitizeFilename(hermesLearningsTitle(dealName))}.md`;
}

export function renderHermesLearningsStub(
  dealName: string,
  dealId: string,
  briefTitle: string,
): string {
  const now = formatIsoTimestamp();

  return `---
type: hermes_learnings
source: hermes
deal_hubspot_id: "${dealId}"
deal_brief: "[[${briefTitle}]]"
created_at: ${now}
updated_at: ${now}
tags: [gtm, hermes, learning, deal]
---

# ${hermesLearningsTitle(dealName)}

> **Hermes analysis — not HubSpot data.** This note is written and updated by Hermes after reviewing synced CRM notes (\`source: hubspot\`). For facts, always prefer [[${briefTitle}]] and linked activities.

## CRM facts (reference only — do not edit here)

_Summarize key facts from the Deal Brief. Link to HubSpot notes; do not invent._

- Deal: ${wikilink(dealName)}
- Brief: ${wikilink(briefTitle)}

## Learnings

_Agent interpretation: deal dynamics, positioning, objections, next steps._

### What happened (interpretation)

_To be filled by Hermes review._

### Messaging angles for V7

_To be filled by Hermes review._

### Risks and open questions

_To be filled by Hermes review._

## Sources reviewed

_List HubSpot-synced notes read (\`source: hubspot\`)._

- ${wikilink(briefTitle)}
`;
}

export async function ensureHermesLearningsNote(
  vaultPath: string,
  dealFolder: string,
  dealName: string,
  dealId: string,
  briefTitle: string,
): Promise<{ path: string; created: boolean; absolutePath: string }> {
  const relativePath = hermesLearningsRelativePath(dealFolder, dealName);
  const content = renderHermesLearningsStub(dealName, dealId, briefTitle);
  const result = await ensureVaultNoteIfMissing(vaultPath, relativePath, content);

  return {
    path: relativePath,
    created: result.created,
    absolutePath: join(vaultPath, relativePath),
  };
}

export function hubspotSourceBanner(): string {
  return "> **HubSpot CRM (synced).** Factual record from HubSpot — re-sync overwrites this note. Hermes learnings live separately in \`hermes/\`.";
}

export function hermesSourceBanner(briefTitle: string): string {
  return `> **Hermes analysis.** Agent interpretation — verify against ${wikilink(briefTitle)} before acting. Re-sync does **not** overwrite this note.`;
}
