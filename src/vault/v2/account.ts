import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { DealManifest } from "../../hubspot/manifest.js";
import { getCompany, listCompanyDealIds } from "../../hubspot/company.js";
import { buildDealManifest } from "../../hubspot/manifest.js";
import { getCompanyName } from "../../hubspot/deals.js";
import { companyRecordUrl } from "../../hubspot/company.js";
import { hubspotSourceBanner } from "../learnings.js";
import { sanitizeFilename, upsertVaultNote, wikilink } from "../writer.js";
import { dealFolderPathV2 } from "./paths.js";
import { briefNoteTitle } from "./render.js";

const CAPITAL_DYNAMICS_COMPANY_ID = "29053398081";

// Obsidian Bases embed for the Capital Dynamics pilot. The .base file itself is
// owned/authored elsewhere; the account rollup only guarantees the embed survives
// a HubSpot re-sync.
const PILOT_BASE_EMBED = "![[capital-dynamics.base#Deals]]";

const BASE_EMBED_PATTERN = /!\[\[[^\]]*\.base[^\]]*\]\]/g;

/**
 * Pull every Obsidian Bases embed (`![[*.base#View]]`) out of an existing
 * Account.md so a re-sync can re-emit them instead of clobbering them.
 */
export function extractBaseEmbeds(content: string): string[] {
  const matches = content.match(BASE_EMBED_PATTERN) ?? [];
  return [...new Set(matches)];
}

async function readExistingBaseEmbeds(
  vaultPath: string,
  relativePath: string,
): Promise<string[]> {
  const absolute = join(vaultPath, relativePath);
  if (!existsSync(absolute)) {
    return [];
  }
  try {
    const content = await readFile(absolute, "utf8");
    return extractBaseEmbeds(content);
  } catch {
    return [];
  }
}

export function accountFolderPath(companyId: string, companyName: string): string {
  const slug = sanitizeFilename(companyName).slice(0, 60);
  return `GTM/Accounts/${companyId} ${slug}`;
}

export function accountFileName(): string {
  return "Account.md";
}

export type AccountDealRow = {
  dealId: string;
  dealName: string;
  motion: string;
  stageLabel: string;
  pipelineLabel: string;
  amount: string;
  briefFolder: string;
};

export function renderAccountMd(params: {
  companyId: string;
  companyName: string;
  companyDomain: string;
  hubspotUrl: string;
  syncedAt: string;
  deals: AccountDealRow[];
  baseEmbeds?: string[];
}): string {
  const tags = ["gtm", "hubspot", "account"];
  if (params.companyId === CAPITAL_DYNAMICS_COMPANY_ID) {
    tags.push("gtm/capital-dynamics");
  }

  // Preserve any Bases embeds the vault already carries. Seed the pilot embed
  // for Capital Dynamics so the view persists even on a first/clean re-sync.
  const embeds = [...new Set(params.baseEmbeds ?? [])];
  if (params.companyId === CAPITAL_DYNAMICS_COMPANY_ID && embeds.length === 0) {
    embeds.push(PILOT_BASE_EMBED);
  }
  const viewsBlock =
    embeds.length > 0
      ? `## Views

${embeds.join("\n")}

`
      : "";

  const dealRows = params.deals
    .map((deal) => {
      const briefLink = wikilink(`${deal.briefFolder}/${briefNoteTitle()}`);
      return `| ${deal.dealName.replace(/\|/g, "\\|")} | ${deal.motion} | ${deal.stageLabel.replace(/\|/g, "\\|")} | ${deal.pipelineLabel.replace(/\|/g, "\\|")} | ${deal.amount || "—"} | ${briefLink} |`;
    })
    .join("\n");

  const briefLinksBlock =
    params.deals.length > 0
      ? params.deals
          .slice(0, 8)
          .map((deal) => `- ${wikilink(`${deal.briefFolder}/${briefNoteTitle()}`)} — ${deal.dealName}`)
          .join("\n")
      : "_No deals linked to this account._";

  return `---
type: account
source: hubspot
hubspot_id: "${params.companyId}"
aliases: ["${params.companyName.replace(/"/g, '\\"')}"]
synced_at: ${params.syncedAt}
tags: [${tags.join(", ")}]
---

# ${params.companyName}

${hubspotSourceBanner()}

> [!important] Account snapshot
> | Domain | Deals | Pilot |
> |--------|-------|-------|
> | ${params.companyDomain || "—"} | ${params.deals.length} | ${params.companyId === CAPITAL_DYNAMICS_COMPANY_ID ? "Capital Dynamics" : "—"} |

${viewsBlock}## Deals

| Deal | Motion | Stage | Pipeline | Amount | Brief |
|------|--------|-------|----------|--------|-------|
${dealRows || "| — | — | — | — | — | — |"}

## Deal briefs (wikilink budget ≤8)

${briefLinksBlock}

## HubSpot

[Open company in HubSpot](${params.hubspotUrl})
`;
}

export async function syncAccountRollup(
  vaultPath: string,
  companyId: string,
  seedManifest?: DealManifest,
): Promise<{ path: string; dealCount: number }> {
  const company = await getCompany(companyId);
  const companyName = getCompanyName(company);
  const folder = accountFolderPath(companyId, companyName);
  const syncedAt = new Date().toISOString();

  const dealIds = await listCompanyDealIds(companyId);
  if (seedManifest && !dealIds.includes(seedManifest.deal_id)) {
    dealIds.unshift(seedManifest.deal_id);
  }

  const deals: AccountDealRow[] = [];
  for (const dealId of dealIds) {
    const manifest =
      seedManifest?.deal_id === dealId
        ? seedManifest
        : await buildDealManifest(dealId, { vaultPath });
    deals.push({
      dealId: manifest.deal_id,
      dealName: manifest.deal_name,
      motion: manifest.motion,
      stageLabel: manifest.stage?.label ?? "",
      pipelineLabel: manifest.pipeline?.label ?? "",
      amount: manifest.properties.amount ?? "",
      briefFolder: dealFolderPathV2(manifest.deal_id, manifest.deal_name),
    });
  }

  const relativePath = `${folder}/${accountFileName()}`;
  await mkdir(join(vaultPath, folder), { recursive: true });
  const baseEmbeds = await readExistingBaseEmbeds(vaultPath, relativePath);
  const saved = await upsertVaultNote(
    vaultPath,
    relativePath,
    renderAccountMd({
      companyId,
      companyName,
      companyDomain: company.properties.domain?.trim() ?? "",
      hubspotUrl: companyRecordUrl(companyId),
      syncedAt,
      deals,
      baseEmbeds,
    }),
    companyId,
    { dedupScope: folder },
  );

  return { path: saved.path, dealCount: deals.length };
}
