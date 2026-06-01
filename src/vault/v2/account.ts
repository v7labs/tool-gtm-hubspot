import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { DealManifest } from "../../hubspot/manifest.js";
import { getCompany, listCompanyDealIds } from "../../hubspot/company.js";
import { getManifestRunCache } from "../../hubspot/manifest-cache.js";
import { batchReadObjects } from "../../hubspot/client.js";
import {
  batchGetAssociations,
  formatAssociationLabels,
  getAssociationSchema,
} from "../../hubspot/associations.js";
import { resolvePipelineStage } from "../../hubspot/pipelines.js";
import {
  deriveMotion,
  loadLifecycleConfig,
  type DealMotion,
} from "../../hubspot/motion.js";
import { getCompanyName, getDealName } from "../../hubspot/deals.js";
import { companyRecordUrl } from "../../hubspot/company.js";
import { hubspotSourceBanner } from "../learnings.js";
import { sanitizeFilename, upsertVaultNote, wikilink } from "../writer.js";
import { dealFolderPathV2 } from "./paths.js";
import { briefNoteTitle } from "./render.js";

// Only the fields the account rollup table renders, plus the inputs
// `deriveMotion` needs. Deliberately a small subset of the full deal-property
// set so a sibling row is one batched read, never a full manifest build.
const ROLLUP_DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "pipeline",
  "dealstage",
  "dealtype",
  "hs_analytics_source",
];

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
  // Company record + sibling deal-id list are seed-independent, so a bulk run
  // loads them once per company instead of once per deal. Returns a fresh copy
  // of dealIds so the per-deal seed unshift below never mutates cached state.
  const { company, dealIds: companyDealIds } = await loadCompanyRollupInputs(companyId);
  const companyName = getCompanyName(company);
  const folder = accountFolderPath(companyId, companyName);
  const syncedAt = new Date().toISOString();

  const dealIds = [...companyDealIds];
  if (seedManifest && !dealIds.includes(seedManifest.deal_id)) {
    dealIds.unshift(seedManifest.deal_id);
  }

  const deals = await buildAccountDealRows(dealIds, vaultPath, seedManifest);

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

async function loadCompanyRollupInputs(
  companyId: string,
): Promise<{ company: Awaited<ReturnType<typeof getCompany>>; dealIds: string[] }> {
  const load = async () => ({
    company: await getCompany(companyId),
    dealIds: await listCompanyDealIds(companyId),
  });

  const cache = getManifestRunCache();
  return cache ? cache.getOrLoadCompanyInputs(companyId, load) : load();
}

function rollupRow(params: {
  dealId: string;
  dealName: string;
  motion: DealMotion;
  stageLabel: string;
  pipelineLabel: string;
  amount: string;
}): AccountDealRow {
  return {
    dealId: params.dealId,
    dealName: params.dealName,
    motion: params.motion,
    stageLabel: params.stageLabel,
    pipelineLabel: params.pipelineLabel,
    amount: params.amount,
    briefFolder: dealFolderPathV2(params.dealId, params.dealName),
  };
}

/**
 * Build the account-rollup table rows for every deal in a company.
 *
 * Previously this rebuilt a FULL DealManifest per sibling deal (activities,
 * contacts, per-activity associations, …) just to read each deal's
 * name/stage/pipeline/amount/motion for one table row — an O(siblings) API
 * fan-out that dominated per-deal call volume. The rollup only needs a handful
 * of deal properties plus the deal↔deal edges that feed `deriveMotion`, so we
 * fetch ALL siblings in two batched reads (`batchReadObjects` +
 * `batchGetAssociations`, ≤100 ids/chunk) and derive each row locally.
 *
 * Output is byte-for-byte identical to the per-manifest path: name, amount, and
 * pipeline/stage labels come from the same properties via the same
 * `resolvePipelineStage`, and motion is the same `deriveMotion` call with the
 * same referral-edge signal — only the transport (batched vs per-deal) changes.
 * The triggering deal's row is taken from its already-built `seedManifest`.
 */
async function buildAccountDealRows(
  dealIds: string[],
  vaultPath: string,
  seedManifest: DealManifest | undefined,
): Promise<AccountDealRow[]> {
  const seedId = seedManifest?.deal_id;
  const fetchIds = dealIds.filter((id) => id !== seedId);

  const [dealRecords, dealDealEdges, lifecycle] = await Promise.all([
    batchReadObjects("deals", fetchIds, ROLLUP_DEAL_PROPERTIES),
    batchGetAssociations("deals", fetchIds, "deals"),
    loadLifecycleConfig(vaultPath),
  ]);
  // deals→deals labels feed the referral-motion signal; schema is cached once
  // per run after the first lookup (and skipped entirely when nothing to fetch).
  const dealDealSchema =
    fetchIds.length > 0 ? await getAssociationSchema("deals", "deals") : [];
  const recordById = new Map(dealRecords.map((record) => [record.id, record]));

  const rows: AccountDealRow[] = [];
  for (const dealId of dealIds) {
    if (seedManifest && dealId === seedId) {
      rows.push(
        rollupRow({
          dealId: seedManifest.deal_id,
          dealName: seedManifest.deal_name,
          motion: seedManifest.motion,
          stageLabel: seedManifest.stage?.label ?? "",
          pipelineLabel: seedManifest.pipeline?.label ?? "",
          amount: seedManifest.properties.amount ?? "",
        }),
      );
      continue;
    }

    const record = recordById.get(dealId);
    if (!record) {
      // listCompanyDealIds only returns currently-associated deals; a missing
      // record means the deal was unreadable between listing and read. Skip it
      // rather than fail the whole rollup (the prior per-manifest path would
      // have thrown here).
      continue;
    }

    const properties = record.properties;
    const { pipeline, stage } = await resolvePipelineStage(
      properties.pipeline ?? null,
      properties.dealstage ?? null,
    );
    const edges = dealDealEdges.get(dealId) ?? [];
    const hasReferralDealEdge = edges.some((edge) =>
      formatAssociationLabels(edge.associationTypes, dealDealSchema).some(
        (label) => /referral|referred|source/i.test(label),
      ),
    );
    const motion = deriveMotion({
      dealId,
      pipelineId: pipeline?.id ?? properties.pipeline ?? null,
      pipelineLabel: pipeline?.label ?? null,
      stageLabel: stage?.label ?? null,
      dealtype: properties.dealtype ?? "",
      hsDealSource: properties.hs_analytics_source ?? "",
      hasReferralDealEdge,
      lifecycle,
    });

    rows.push(
      rollupRow({
        dealId,
        dealName: getDealName(record),
        motion,
        stageLabel: stage?.label ?? "",
        pipelineLabel: pipeline?.label ?? "",
        amount: properties.amount ?? "",
      }),
    );
  }

  return rows;
}
