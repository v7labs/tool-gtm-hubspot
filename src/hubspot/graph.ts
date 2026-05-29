import { batchReadObjects } from "./client.js";
import {
  enrichEdgesWithLabels,
  getAssociations,
  isPrimaryCompanyAssociation,
  sortAssociationEdges,
} from "./associations.js";
import { getDealActivities } from "./activities.js";
import { getDeal } from "./deals.js";
import type { AssociatedRecord, DealGraph, HubSpotRecord } from "./types.js";

export async function getDealGraph(dealId: string): Promise<DealGraph> {
  const deal = await getDeal(dealId);
  const [companyEdges, contactEdges, activities] = await Promise.all([
    getAssociations("deals", dealId, "companies"),
    getAssociations("deals", dealId, "contacts"),
    getDealActivities(dealId),
  ]);

  const [enrichedCompanyEdges, enrichedContactEdges] = await Promise.all([
    enrichEdgesWithLabels("deals", "companies", sortAssociationEdges(companyEdges)),
    enrichEdgesWithLabels("deals", "contacts", contactEdges),
  ]);

  const [companyRecords, contactRecords] = await Promise.all([
    batchReadObjects("companies", enrichedCompanyEdges.map((edge) => edge.toObjectId), [
      "name",
      "domain",
      "industry",
      "hubspot_owner_id",
    ]),
    batchReadObjects("contacts", enrichedContactEdges.map((edge) => edge.toObjectId), [
      "firstname",
      "lastname",
      "email",
      "jobtitle",
      "hubspot_owner_id",
    ]),
  ]);

  const companies = mergeAssociatedRecords(companyRecords, enrichedCompanyEdges, (types) =>
    isPrimaryCompanyAssociation(types),
  );
  const contacts = mergeAssociatedRecords(contactRecords, enrichedContactEdges);

  return {
    deal,
    companies,
    contacts,
    activities,
  };
}

function mergeAssociatedRecords(
  records: HubSpotRecord[],
  edges: Array<{ toObjectId: string; associationTypes: AssociatedRecord["associationTypes"]; labels: string[] }>,
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
