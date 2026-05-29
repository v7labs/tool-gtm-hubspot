import {
  batchGetAssociations,
  enrichEdgesWithLabels,
  formatAssociationLabels,
  getAssociationSchema,
  getAssociations,
  isPrimaryCompanyAssociation,
  sortAssociationEdges,
} from "./associations.js";
import { getDealActivities } from "./activities.js";
import { classifyActivities, type ClassifiedActivity } from "./engagements.js";
import { getDeal, getDealName } from "./deals.js";
import { batchReadObjects } from "./client.js";
import {
  dealRecordUrl,
  resolveOwnerName,
  resolvePipelineStage,
} from "./pipelines.js";
import { buildGongManifestEdges, type GongCallRef } from "./gong.js";
import { deriveMotion, loadLifecycleConfig, type DealMotion } from "./motion.js";
import { getVaultPath } from "../config.js";
import type { AssociatedRecord, ActivityType, HubSpotRecord } from "./types.js";
import { ACTIVITY_TYPES } from "./types.js";

export type ManifestObjectRef = {
  type: string;
  id: string;
};

export type ManifestEdge = {
  from: ManifestObjectRef;
  to: ManifestObjectRef;
  labels: string[];
};

export type DealManifest = {
  deal_id: string;
  deal_name: string;
  synced_at: string;
  hubspot_url: string;
  motion: DealMotion;
  primary_company_id: string | null;
  related_deal_ids: string[];
  pipeline: { id: string; label: string } | null;
  stage: { id: string; label: string } | null;
  owner: { id: string; name: string | null };
  properties: Record<string, string>;
  edges: ManifestEdge[];
  gong_calls: GongCallRef[];
  companies: AssociatedRecord[];
  contacts: AssociatedRecord[];
  // Contacts that appear as activity (meeting/email/call) participants but are
  // NOT directly associated with the deal. Rendered as entity pages so the link
  // graph can resolve activity→contact edges; deliberately kept out of
  // `contacts` so the Brief/Account glance stays focused on deal contacts.
  engagement_contacts: AssociatedRecord[];
  activities: ClassifiedActivity[];
};

function ref(type: string, id: string): ManifestObjectRef {
  return { type, id };
}

function pushEdge(
  edges: ManifestEdge[],
  from: ManifestObjectRef,
  to: ManifestObjectRef,
  labels: string[],
): void {
  edges.push({ from, to, labels });
}

export async function buildDealManifest(
  dealId: string,
  options?: { vaultPath?: string },
): Promise<DealManifest> {
  const vaultPath = options?.vaultPath ?? getVaultPath();
  const lifecycle = await loadLifecycleConfig(vaultPath);
  const syncedAt = new Date().toISOString();
  const deal = await getDeal(dealId);
  const dealName = getDealName(deal);
  const dealRef = ref("deal", dealId);

  const [companyEdges, contactEdges, dealDealEdges, activitiesRaw] = await Promise.all([
    getAssociations("deals", dealId, "companies"),
    getAssociations("deals", dealId, "contacts"),
    getAssociations("deals", dealId, "deals"),
    getDealActivities(dealId, { limit: 500 }),
  ]);

  const [enrichedCompanies, enrichedContacts, enrichedDealDeals] = await Promise.all([
    enrichEdgesWithLabels("deals", "companies", sortAssociationEdges(companyEdges)),
    enrichEdgesWithLabels("deals", "contacts", contactEdges),
    enrichEdgesWithLabels("deals", "deals", dealDealEdges),
  ]);

  const [companyRecords, contactRecords] = await Promise.all([
    batchReadObjects("companies", enrichedCompanies.map((edge) => edge.toObjectId), [
      "name",
      "domain",
      "industry",
    ]),
    batchReadObjects("contacts", enrichedContacts.map((edge) => edge.toObjectId), [
      "firstname",
      "lastname",
      "email",
      "jobtitle",
    ]),
  ]);

  const companies = mergeRecords(companyRecords, enrichedCompanies, (types) =>
    isPrimaryCompanyAssociation(types),
  );
  const contacts = mergeRecords(contactRecords, enrichedContacts);

  const activities = classifyActivities(activitiesRaw);
  const edges: ManifestEdge[] = [];

  for (const company of enrichedCompanies) {
    pushEdge(edges, dealRef, ref("company", company.toObjectId), company.labels);
  }
  for (const contact of enrichedContacts) {
    pushEdge(edges, dealRef, ref("contact", contact.toObjectId), contact.labels);
  }
  for (const related of enrichedDealDeals) {
    pushEdge(edges, dealRef, ref("deal", related.toObjectId), related.labels);
  }

  for (const type of ACTIVITY_TYPES) {
    const typeActivities = activities.filter((item) => item.type === type);
    const ids = typeActivities.map((item) => item.id);
    if (ids.length === 0) {
      continue;
    }

    for (const activity of typeActivities) {
      pushEdge(edges, dealRef, ref(type, activity.id), ["Deal engagement"]);
    }

    const contactBatch = await batchGetAssociations(type, ids, "contacts");
    const schema = await getAssociationSchema(type, "contacts");
    for (const activity of typeActivities) {
      const contactEdgesForActivity = contactBatch.get(activity.id) ?? [];
      activity.associatedContactIds = contactEdgesForActivity.map((edge) => edge.toObjectId);
      activity.associatedContactLabels = Object.fromEntries(
        contactEdgesForActivity.map((edge) => [
          edge.toObjectId,
          formatAssociationLabels(edge.associationTypes, schema),
        ]),
      );
      for (const contactEdge of contactEdgesForActivity) {
        pushEdge(
          edges,
          ref(type, activity.id),
          ref("contact", contactEdge.toObjectId),
          formatAssociationLabels(contactEdge.associationTypes, schema),
        );
      }
    }
  }

  for (const contact of contacts) {
    const companyEdges = await getAssociations("contacts", contact.id, "companies");
    const enriched = await enrichEdgesWithLabels("contacts", "companies", companyEdges);
    for (const edge of enriched) {
      pushEdge(edges, ref("contact", contact.id), ref("company", edge.toObjectId), edge.labels);
    }
  }

  // Engagement participants: contacts linked to an activity but not to the deal
  // itself. They get entity pages (below + in sync) so activity→contact edges
  // resolve in the graph, without polluting the deal's direct-contact list.
  const dealContactIds = new Set(contacts.map((contact) => contact.id));
  const participantIds = new Set<string>();
  for (const activity of activities) {
    for (const id of activity.associatedContactIds ?? []) {
      if (!dealContactIds.has(id)) {
        participantIds.add(id);
      }
    }
  }
  const engagementContactRecords =
    participantIds.size > 0
      ? await batchReadObjects("contacts", [...participantIds], [
          "firstname",
          "lastname",
          "email",
          "jobtitle",
        ])
      : [];
  const engagementContacts: AssociatedRecord[] = engagementContactRecords.map((record) => ({
    ...record,
    associationTypes: [],
    associationLabels: ["Engagement participant"],
    isPrimary: false,
  }));

  const meetings = activities.filter((item) => item.type === "meetings");
  const contactsByEmail = new Map<string, string>();
  for (const contact of contacts) {
    const email = contact.properties.email?.trim().toLowerCase();
    if (email) {
      contactsByEmail.set(email, contact.id);
    }
  }
  const { edges: gongEdges, gongCalls } = buildGongManifestEdges(meetings, contactsByEmail);
  for (const gongEdge of gongEdges) {
    edges.push(gongEdge);
  }

  const primaryCompany =
    companies.find((company) => company.isPrimary) ?? companies[0] ?? null;
  const relatedDealIds = enrichedDealDeals.map((edge) => edge.toObjectId);

  const { pipeline, stage } = await resolvePipelineStage(
    deal.properties.pipeline,
    deal.properties.dealstage,
  );
  const ownerId = deal.properties.hubspot_owner_id ?? "";
  const ownerName = await resolveOwnerName(ownerId || null);

  const properties: Record<string, string> = {
    amount: deal.properties.amount ?? "",
    closedate: deal.properties.closedate ?? "",
    dealtype: deal.properties.dealtype ?? "",
    description: deal.properties.description ?? "",
    hs_deal_stage_probability: deal.properties.hs_deal_stage_probability ?? "",
    hs_deal_source:
      deal.properties.hs_deal_source ??
      deal.properties.hs_analytics_source ??
      "",
  };

  const hasReferralDealEdge = enrichedDealDeals.some((edge) =>
    edge.labels.some((label) => /referral|referred|source/i.test(label)),
  );

  const motion = deriveMotion({
    dealId,
    pipelineId: pipeline?.id ?? deal.properties.pipeline ?? null,
    pipelineLabel: pipeline?.label ?? null,
    stageLabel: stage?.label ?? null,
    dealtype: properties.dealtype,
    hsDealSource: properties.hs_deal_source,
    hasReferralDealEdge,
    lifecycle,
  });

  return {
    deal_id: dealId,
    deal_name: dealName,
    synced_at: syncedAt,
    hubspot_url: dealRecordUrl(dealId),
    motion,
    primary_company_id: primaryCompany?.id ?? null,
    related_deal_ids: relatedDealIds,
    pipeline: pipeline ? { id: pipeline.id, label: pipeline.label } : null,
    stage: stage ? { id: stage.id, label: stage.label } : null,
    owner: { id: ownerId, name: ownerName },
    properties,
    edges,
    gong_calls: gongCalls,
    companies,
    contacts,
    engagement_contacts: engagementContacts,
    activities,
  };
}

function mergeRecords(
  records: HubSpotRecord[],
  edges: Array<{
    toObjectId: string;
    associationTypes: AssociatedRecord["associationTypes"];
    labels: string[];
  }>,
  isPrimary?: (types: AssociatedRecord["associationTypes"]) => boolean,
): AssociatedRecord[] {
  const recordById = new Map(records.map((record) => [record.id, record]));
  const merged: AssociatedRecord[] = [];

  for (const edge of edges) {
    const record = recordById.get(edge.toObjectId);
    if (!record) {
      continue;
    }
    merged.push({
      ...record,
      associationTypes: edge.associationTypes,
      associationLabels: edge.labels,
      isPrimary: isPrimary?.(edge.associationTypes) ?? false,
    });
  }

  return merged;
}

export function serializeManifestYaml(manifest: DealManifest): string {
  const lines: string[] = [
    `deal_id: "${manifest.deal_id}"`,
    `deal_name: "${escapeYaml(manifest.deal_name)}"`,
    `synced_at: ${manifest.synced_at}`,
    `hubspot_url: "${manifest.hubspot_url}"`,
  ];

  if (manifest.pipeline) {
    lines.push(`pipeline:`);
    lines.push(`  id: "${manifest.pipeline.id}"`);
    lines.push(`  label: "${escapeYaml(manifest.pipeline.label)}"`);
  }
  if (manifest.stage) {
    lines.push(`stage:`);
    lines.push(`  id: "${manifest.stage.id}"`);
    lines.push(`  label: "${escapeYaml(manifest.stage.label)}"`);
  }

  lines.push(`motion: ${manifest.motion}`);
  if (manifest.primary_company_id) {
    lines.push(`primary_company_id: "${manifest.primary_company_id}"`);
  }
  if (manifest.related_deal_ids.length > 0) {
    lines.push(
      `related_deal_ids: [${manifest.related_deal_ids.map((id) => `"${id}"`).join(", ")}]`,
    );
  }

  lines.push(`owner:`);
  lines.push(`  id: "${manifest.owner.id}"`);
  lines.push(`  name: "${escapeYaml(manifest.owner.name ?? "")}"`);

  lines.push(`edges:`);
  for (const edge of manifest.edges) {
    lines.push(`  - from: { type: ${edge.from.type}, id: "${edge.from.id}" }`);
    lines.push(`    to: { type: ${edge.to.type}, id: "${edge.to.id}" }`);
    lines.push(`    labels: [${edge.labels.map((label) => `"${escapeYaml(label)}"`).join(", ")}]`);
  }

  if (manifest.gong_calls.length > 0) {
    lines.push(`gong_calls:`);
    for (const call of manifest.gong_calls) {
      lines.push(`  - id: "${call.id}"`);
      lines.push(`    meeting_id: "${call.meeting_id}"`);
      lines.push(`    placeholder: ${call.placeholder}`);
    }
  }

  lines.push(`engagements:`);
  for (const activity of manifest.activities) {
    lines.push(`  - id: "${activity.id}"`);
    lines.push(`    type: ${activity.type}`);
    lines.push(`    class: ${activity.engagementClass}`);
    if (activity.alsoHubspotIds?.length) {
      lines.push(
        `    also_hubspot_ids: [${activity.alsoHubspotIds.map((id) => `"${id}"`).join(", ")}]`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function hasManifestEdge(
  manifest: DealManifest,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
): boolean {
  return manifest.edges.some(
    (edge) =>
      edge.from.type === fromType &&
      edge.from.id === fromId &&
      edge.to.type === toType &&
      edge.to.id === toId,
  );
}
