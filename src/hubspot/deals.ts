import { getHubSpotClient } from "./client.js";
import { scheduleHubSpotRequest } from "./rate-limiter.js";
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
  // Lead-source attribution. Only properties confirmed to exist on the deals
  // object in this portal are fetched (verified 2026-05-31 via the properties
  // API). `hs_latest_source*` and `hs_deal_source` are NOT present on deals
  // here (latest-source lives on the contact), so they are intentionally
  // omitted — see manifest.ts/stage-history.ts for the contact-side source.
  "hs_analytics_source",
  "hs_analytics_source_data_1",
  "hs_analytics_source_data_2",
  "hs_object_source",
  "hs_object_source_label",
  "hs_object_source_detail_1",
  "hs_object_source_detail_2",
  "hs_object_source_detail_3",
];

export async function getDeal(dealId: string): Promise<HubSpotRecord> {
  const hubspot = getHubSpotClient();
  const deal = await scheduleHubSpotRequest(() =>
    hubspot.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES),
  );
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
