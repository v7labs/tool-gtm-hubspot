import { readFile } from "node:fs/promises";
import type { DealManifest } from "../../hubspot/manifest.js";
import type { AssociatedRecord } from "../../hubspot/types.js";
import { getContactName } from "../../hubspot/deals.js";
import { getHubSpotPortalId } from "../../hubspot/pipelines.js";
import {
  findVaultFileByHubspotId,
  upsertVaultNote,
} from "../writer.js";
import {
  accountHubWikilink,
  briefHubWikilink,
  contactHubPath,
  contactsHubFolder,
} from "./paths.js";
import { mergeTags } from "./tags.js";

const CAPITAL_DYNAMICS_COMPANY_ID = "29053398081";

/**
 * Upsert the canonical, vault-level contact hub (`GTM/Contacts/{id} {slug}.md`)
 * for one contact, ACCUMULATING this deal's Brief link + its company Account
 * link into the single note. Mirrors `scripts/dedup-entities-to-hubs.mjs`: one
 * node per person that links every deal it appears on, so contacts become the
 * cross-deal connectors in the graph instead of per-deal duplicate stubs.
 *
 * Accumulation is by read-merge-write (dedup by deal id / company id in the link
 * lines), so a full re-sync sweep builds the complete hub and a re-run is a
 * no-op. The migration script remains the authoritative full rebuild if an
 * association is later removed.
 */
export async function upsertContactHub(
  vaultPath: string,
  contact: AssociatedRecord,
  manifest: DealManifest,
  accountNoteBasename?: string,
): Promise<string> {
  const contactId = contact.id;
  const name = getContactName(contact);
  const relative = contactHubPath(contactId, name);

  const existing = await readExistingHub(vaultPath, contactId);

  const email = (contact.properties.email?.trim() || existing.email || "").trim();
  const title = (contact.properties.jobtitle?.trim() || existing.title || "").trim();

  // This deal's brief link line + its primary-company account link line. The
  // primary company's Account note is guaranteed on disk by the account rollup
  // that runs later in the same syncDealMap, so the link always resolves.
  const dealLine = `- ${briefHubWikilink(manifest.deal_id, manifest.deal_name)}`;
  const dealLinks = mergeLinkLines(existing.dealLinks, dealLine, /GTM\/Deals\/(\d+) /);

  const companyLines = [...existing.companyLines];
  const dealIds = mergeIds(existing.dealIds, manifest.deal_id);
  const companyIds = [...existing.companyIds];
  const primaryId = manifest.primary_company_id;
  if (primaryId) {
    const primaryCompany =
      manifest.companies.find((company) => company.isPrimary) ??
      manifest.companies.find((company) => company.id === primaryId) ??
      manifest.companies[0];
    if (primaryCompany) {
      const companyLine = `- ${accountHubWikilink(primaryId, primaryCompany.properties.name?.trim() || `Company ${primaryId}`, accountNoteBasename)}`;
      const merged = mergeLinkLines(companyLines, companyLine, /GTM\/Accounts\/(\d+) /);
      companyLines.length = 0;
      companyLines.push(...merged);
    }
    if (!companyIds.includes(primaryId)) {
      companyIds.push(primaryId);
    }
  }

  const isPilot =
    existing.pilot || companyIds.includes(CAPITAL_DYNAMICS_COMPANY_ID);
  const tags = mergeTags(
    ["gtm", "hubspot", "contact"],
    isPilot ? ["gtm/capital-dynamics"] : [],
  );

  const aliasName = name.replace(/[[\]|"]/g, "").trim();
  const content = renderContactHub({
    contactId,
    aliasName,
    email,
    title,
    primaryCompanyId: companyIds[0] ?? "",
    companyIds,
    dealIds,
    tags,
    companyLines,
    dealLinks,
  });

  const saved = await upsertVaultNote(vaultPath, relative, content, contactId, {
    dedupScope: contactsHubFolder(),
  });
  return saved.path;
}

type ExistingHub = {
  email: string;
  title: string;
  dealIds: string[];
  companyIds: string[];
  dealLinks: string[];
  companyLines: string[];
  pilot: boolean;
};

async function readExistingHub(
  vaultPath: string,
  contactId: string,
): Promise<ExistingHub> {
  const empty: ExistingHub = {
    email: "",
    title: "",
    dealIds: [],
    companyIds: [],
    dealLinks: [],
    companyLines: [],
    pilot: false,
  };
  const absolute = await findVaultFileByHubspotId(
    vaultPath,
    contactId,
    contactsHubFolder(),
  );
  if (!absolute) {
    return empty;
  }
  let content: string;
  try {
    content = await readFile(absolute, "utf8");
  } catch {
    return empty;
  }
  return {
    email: tableValue(content, "Email"),
    title: tableValue(content, "Title"),
    dealIds: frontmatterList(content, "deal_hubspot_ids"),
    companyIds: frontmatterList(content, "company_ids"),
    dealLinks: sectionLinkLines(content, "Deals"),
    companyLines: sectionLinkLines(content, "Company"),
    pilot: /tags:.*gtm\/capital-dynamics/.test(content),
  };
}

function renderContactHub(params: {
  contactId: string;
  aliasName: string;
  email: string;
  title: string;
  primaryCompanyId: string;
  companyIds: string[];
  dealIds: string[];
  tags: string[];
  companyLines: string[];
  dealLinks: string[];
}): string {
  const portal = getHubSpotPortalId();
  return `---
type: contact
source: hubspot
hubspot_id: "${params.contactId}"
aliases: ["${params.aliasName}"]
primary_company_id: "${params.primaryCompanyId}"
company_ids: [${params.companyIds.map((id) => `"${id}"`).join(", ")}]
deal_hubspot_ids: [${params.dealIds.map((id) => `"${id}"`).join(", ")}]
canonical: true
tags: [${params.tags.join(", ")}]
---

# ${params.aliasName}

> **HubSpot CRM (canonical contact hub).** One node per person — links every deal this contact appears on so the account's deals cluster together. Hermes learnings live separately in \`hermes/\`.

| Field | Value |
|-------|-------|
| Email | ${params.email || "—"} |
| Title | ${params.title || "—"} |
| Deals | ${params.dealIds.length} |

## Company

${params.companyLines.join("\n") || "- —"}

## Deals

${params.dealLinks.join("\n") || "- —"}

## HubSpot

[Open contact in HubSpot](https://app.hubspot.com/contacts/${portal}/record/0-1/${params.contactId})
`;
}

/** Append `line` to `lines` unless an existing line references the same id. */
function mergeLinkLines(lines: string[], line: string, idPattern: RegExp): string[] {
  const newId = line.match(idPattern)?.[1];
  if (newId && lines.some((existing) => existing.match(idPattern)?.[1] === newId)) {
    return [...lines];
  }
  return [...lines, line];
}

function mergeIds(ids: string[], id: string): string[] {
  return ids.includes(id) ? [...ids] : [...ids, id];
}

function frontmatterList(content: string, key: string): string[] {
  const m = content.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, "m"));
  if (!m) {
    return [];
  }
  return m[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function tableValue(content: string, label: string): string {
  const m = content.match(new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.*?)\\s*\\|`, "m"));
  const value = m ? m[1].trim() : "";
  return value === "—" ? "" : value;
}

function sectionLinkLines(content: string, heading: string): string[] {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "m");
  const m = re.exec(content);
  if (!m) {
    return [];
  }
  const rest = content.slice(m.index + m[0].length);
  const nextHeading = rest.search(/^##\s/m);
  const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [["));
}
