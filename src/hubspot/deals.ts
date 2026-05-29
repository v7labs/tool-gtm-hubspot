import { getHubSpotClient } from "./client.js";
import type { HubSpotRecord } from "./types.js";

const DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "pipeline",
  "hubspot_owner_id",
  "description",
  "hs_lastmodifieddate",
  "dealtype",
  "hs_analytics_source",
  "hs_deal_source",
];

export async function getDeal(dealId: string): Promise<HubSpotRecord> {
  const hubspot = getHubSpotClient();
  const deal = await hubspot.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES);
  return {
    id: deal.id,
    properties: deal.properties ?? {},
    url: (deal as { url?: string }).url,
  };
}

export function getDealName(deal: HubSpotRecord): string {
  return deal.properties.dealname?.trim() || `Deal ${deal.id}`;
}

export function getCompanyName(company: HubSpotRecord): string {
  return company.properties.name?.trim() || `Company ${company.id}`;
}

export function getContactName(contact: HubSpotRecord): string {
  const first = contact.properties.firstname?.trim() ?? "";
  const last = contact.properties.lastname?.trim() ?? "";
  const full = `${first} ${last}`.trim();
  return full || contact.properties.email?.trim() || `Contact ${contact.id}`;
}
