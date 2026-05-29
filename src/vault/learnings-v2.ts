import { join } from "node:path";
import {
  ensureVaultNoteIfMissing,
  formatIsoTimestamp,
  wikilink,
} from "./writer.js";
import { hermesLearningsPath } from "./v2/paths.js";
import { briefNoteTitle, learningsNoteTitle } from "./v2/render.js";

export function renderHermesLearningsStubV2(dealId: string, dealName: string): string {
  const now = formatIsoTimestamp();
  const briefTitle = briefNoteTitle();
  const learningsTitle = learningsNoteTitle();

  return `---
type: hermes_learnings
source: hermes
deal_hubspot_id: "${dealId}"
deal_brief: "[[${briefTitle}]]"
created_at: ${now}
updated_at: ${now}
tags: [gtm, hermes, learning, deal]
---

# ${learningsTitle}

> **Hermes analysis — not HubSpot data.** This note is written and updated by Hermes after reviewing synced CRM notes (\`source: hubspot\`). For facts, always prefer [[${briefTitle}]] and \`manifest.yaml\`.

## CRM facts (reference only — do not edit here)

_Summarize key facts from the Deal Brief. Link to HubSpot notes; do not invent._

- Deal: ${dealName}
- Brief: ${wikilink(briefTitle)}
- Manifest: \`manifest.yaml\`

## Learnings

_Agent interpretation: deal dynamics, positioning, objections, next steps._

### What happened (interpretation)

_To be filled by Hermes review._

### Messaging angles for V7

_To be filled by Hermes review._

### Risks and open questions

_To be filled by Hermes review._

## Sources reviewed

_List HubSpot-synced notes read (\`source: hubspot\`). Cite manifest edges when describing relationships._

- ${wikilink(briefTitle)}
`;
}

export async function ensureHermesLearningsNoteV2(
  vaultPath: string,
  dealFolder: string,
  dealId: string,
  dealName?: string,
): Promise<{ path: string; created: boolean; absolutePath: string }> {
  const relativePath = `${dealFolder}/${hermesLearningsPath()}`;
  const content = renderHermesLearningsStubV2(dealId, dealName ?? dealId);
  const result = await ensureVaultNoteIfMissing(vaultPath, relativePath, content);

  return {
    path: relativePath,
    created: result.created,
    absolutePath: join(vaultPath, relativePath),
  };
}
