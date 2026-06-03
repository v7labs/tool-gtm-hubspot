import { batchReadObjects } from "./client.js";
import { getAssociations, sortAssociationEdges } from "./associations.js";
import { buildDealManifest } from "./manifest.js";
import { type DealMotion } from "./motion.js";
import { getCompanyName } from "./deals.js";
import { getHubSpotPortalId } from "./pipelines.js";
import { getVaultPath } from "../config.js";
import type { HubSpotRecord } from "./types.js";

const COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  // Geo: drives Account `country` frontmatter + the `#gtm/geo/{country}` cluster
  // lens (one net-new fetched property; zero extra request — same batch read).
  "country",
  "hubspot_owner_id",
  "description",
  "hs_lastmodifieddate",
];

export async function getCompany(companyId: string): Promise<HubSpotRecord> {
  const records = await batchReadObjects("companies", [companyId], COMPANY_PROPERTIES);
  const company = records[0];
  if (!company) {
    throw new Error(`Company ${companyId} not found in HubSpot`);
  }
  return company;
}

export function companyRecordUrl(companyId: string): string {
  return `https://app.hubspot.com/contacts/${getHubSpotPortalId()}/record/0-2/${companyId}`;
}

export type CompanyDealInventory = {
  id: string;
  name: string;
  pipeline: string;
  stage: string;
  motion: DealMotion;
  activity_counts: Record<string, number>;
  contact_ids: string[];
  gong_call_ids: string[];
  datapoint_gaps: string[];
};

export type CompanyContactInventory = {
  id: string;
  name: string;
  email: string;
  deal_ids: string[];
};

export type CompanyGraphInventory = {
  company_id: string;
  company_name: string;
  company_domain: string;
  hubspot_url: string;
  discovered_at: string;
  deals: CompanyDealInventory[];
  contacts: CompanyContactInventory[];
  open_questions: string[];
};

export async function discoverCompanyGraph(
  companyId: string,
  options?: { vaultPath?: string },
): Promise<CompanyGraphInventory> {
  const vaultPath = options?.vaultPath ?? getVaultPath();
  const company = await getCompany(companyId);
  const companyName = getCompanyName(company);

  const dealEdges = await getAssociations("companies", companyId, "deals");
  const dealIds = [...new Set(dealEdges.map((edge) => edge.toObjectId))];

  const contactEdges = await getAssociations("companies", companyId, "contacts");
  const contactIdsFromCompany = new Set(
    contactEdges.map((edge) => edge.toObjectId),
  );

  const deals: CompanyDealInventory[] = [];
  const contactDealMap = new Map<string, Set<string>>();

  for (const dealId of dealIds) {
    const manifest = await buildDealManifest(dealId, { vaultPath });
    // buildDealManifest already derives motion from the lifecycle registry;
    // reuse it so discovery inventory and synced notes never diverge.
    const motion = manifest.motion;

    const activityCounts: Record<string, number> = {};
    for (const activity of manifest.activities) {
      activityCounts[activity.type] = (activityCounts[activity.type] ?? 0) + 1;
    }

    const gaps: string[] = [];
    const meetingCount = activityCounts.meetings ?? 0;
    const gongEdgeCount = manifest.gong_calls.length;
    if (meetingCount > 0 && gongEdgeCount === 0) {
      gaps.push("meetings without gong match");
    }

    for (const contact of manifest.contacts) {
      contactIdsFromCompany.add(contact.id);
      const set = contactDealMap.get(contact.id) ?? new Set();
      set.add(dealId);
      contactDealMap.set(contact.id, set);
    }

    deals.push({
      id: dealId,
      name: manifest.deal_name,
      pipeline: manifest.pipeline?.label ?? "",
      stage: manifest.stage?.label ?? "",
      motion,
      activity_counts: activityCounts,
      contact_ids: manifest.contacts.map((contact) => contact.id),
      gong_call_ids: manifest.gong_calls.map((call) => call.id),
      datapoint_gaps: gaps,
    });
  }

  const contactRecords = await batchReadObjects(
    "contacts",
    [...contactIdsFromCompany],
    ["firstname", "lastname", "email", "jobtitle"],
  );

  const contacts: CompanyContactInventory[] = contactRecords.map((contact) => {
    const first = contact.properties.firstname?.trim() ?? "";
    const last = contact.properties.lastname?.trim() ?? "";
    const name =
      `${first} ${last}`.trim() ||
      contact.properties.email?.trim() ||
      `Contact ${contact.id}`;

    return {
      id: contact.id,
      name,
      email: contact.properties.email?.trim() ?? "",
      deal_ids: [...(contactDealMap.get(contact.id) ?? [])],
    };
  });

  return {
    company_id: companyId,
    company_name: companyName,
    company_domain: company.properties.domain?.trim() ?? "",
    hubspot_url: companyRecordUrl(companyId),
    discovered_at: new Date().toISOString(),
    deals,
    contacts,
    open_questions: [],
  };
}

export function serializeCompanyInventoryYaml(
  inventory: CompanyGraphInventory,
): string {
  const lines: string[] = [
    `company_id: "${inventory.company_id}"`,
    `company_name: ${inventory.company_name}`,
    `discovered_at: ${inventory.discovered_at}`,
    `hubspot_url: "${inventory.hubspot_url}"`,
    `deals:`,
  ];

  for (const deal of inventory.deals) {
    lines.push(`  - id: "${deal.id}"`);
    lines.push(`    name: "${escapeYaml(deal.name)}"`);
    lines.push(`    pipeline: "${escapeYaml(deal.pipeline)}"`);
    lines.push(`    stage: "${escapeYaml(deal.stage)}"`);
    lines.push(`    motion: ${deal.motion}`);
    lines.push(
      `    activity_counts: { ${Object.entries(deal.activity_counts)
        .map(([key, count]) => `${key}: ${count}`)
        .join(", ")} }`,
    );
    lines.push(
      `    contact_ids: [${deal.contact_ids.map((id) => `"${id}"`).join(", ")}]`,
    );
    lines.push(
      `    gong_call_ids: [${deal.gong_call_ids.map((id) => `"${id}"`).join(", ")}]`,
    );
    lines.push(
      `    datapoint_gaps: [${deal.datapoint_gaps.map((gap) => `"${escapeYaml(gap)}"`).join(", ")}]`,
    );
  }

  lines.push(`contacts:`);
  for (const contact of inventory.contacts) {
    lines.push(`  - id: "${contact.id}"`);
    lines.push(`    name: "${escapeYaml(contact.name)}"`);
    lines.push(`    email: "${escapeYaml(contact.email)}"`);
    lines.push(
      `    deal_ids: [${contact.deal_ids.map((id) => `"${id}"`).join(", ")}]`,
    );
  }

  lines.push(`open_questions: [${inventory.open_questions.map((q) => `"${escapeYaml(q)}"`).join(", ")}]`);

  return `${lines.join("\n")}\n`;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function listCompanyDealIds(companyId: string): Promise<string[]> {
  const edges = sortAssociationEdges(
    await getAssociations("companies", companyId, "deals"),
  );
  return edges.map((edge) => edge.toObjectId);
}
