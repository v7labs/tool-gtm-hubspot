import { getHubSpotClient } from "./client.js";
import { scheduleHubSpotRequest } from "./rate-limiter.js";

export type AssociationSpec = {
  typeId: number;
  label: string | null;
  category: string;
};

export type AssociationEdge = {
  toObjectId: string;
  associationTypes: AssociationSpec[];
};

export type AssociationSchemaEntry = AssociationSpec & {
  /** Resolved display label — falls back to category/typeId when HubSpot label is null */
  displayLabel: string;
};

const schemaCache = new Map<string, AssociationSchemaEntry[]>();

function schemaKey(fromType: string, toType: string): string {
  return `${fromType}→${toType}`;
}

export async function getAssociationSchema(
  fromType: string,
  toType: string,
): Promise<AssociationSchemaEntry[]> {
  const key = schemaKey(fromType, toType);
  const cached = schemaCache.get(key);
  if (cached) {
    return cached;
  }

  const hubspot = getHubSpotClient();
  const response = await scheduleHubSpotRequest(
    () =>
      hubspot.crm.associations.v4.schema.definitionsApi.getAll(fromType, toType),
    `assoc.schema.getAll:${fromType}->${toType}`,
  );

  const entries: AssociationSchemaEntry[] = (response.results ?? []).map((spec) => ({
    typeId: spec.typeId,
    label: spec.label ?? null,
    category: spec.category,
    displayLabel: resolveDisplayLabel({
      typeId: spec.typeId,
      label: spec.label ?? null,
      category: spec.category,
    }),
  }));

  schemaCache.set(key, entries);
  return entries;
}

function resolveDisplayLabel(spec: {
  typeId: number;
  label: string | null;
  category: string;
}): string {
  if (spec.label) {
    return spec.label;
  }

  // Well-known HubSpot-defined defaults when label is null
  const known: Record<number, string> = {
    3: "Deal contact",
    5: "Primary company",
    341: "Associated company",
    194: "Call contact",
    198: "Email contact",
    200: "Meeting contact",
    202: "Note contact",
    204: "Task contact",
  };

  return known[spec.typeId] ?? spec.category.replace(/_/g, " ").toLowerCase();
}

export async function getAssociations(
  fromType: string,
  fromId: string,
  toType: string,
): Promise<AssociationEdge[]> {
  const hubspot = getHubSpotClient();
  const edges: AssociationEdge[] = [];
  let after: string | undefined;

  do {
    const page = await scheduleHubSpotRequest(
      () =>
        hubspot.crm.associations.v4.basicApi.getPage(
          fromType,
          fromId,
          toType,
          after,
          500,
        ),
      `assoc.getPage:${fromType}->${toType}`,
    );

    for (const result of page.results ?? []) {
      edges.push({
        toObjectId: String(result.toObjectId),
        associationTypes: (result.associationTypes ?? []).map((spec) => ({
          typeId: spec.typeId,
          label: spec.label ?? null,
          category: spec.category,
        })),
      });
    }

    after = page.paging?.next?.after;
  } while (after);

  return edges;
}

export async function getAssociatedIds(
  fromType: string,
  fromId: string,
  toType: string,
): Promise<string[]> {
  const edges = await getAssociations(fromType, fromId, toType);
  return edges.map((edge) => edge.toObjectId);
}

export async function batchGetAssociations(
  fromType: string,
  fromIds: string[],
  toType: string,
): Promise<Map<string, AssociationEdge[]>> {
  const result = new Map<string, AssociationEdge[]>();
  if (fromIds.length === 0) {
    return result;
  }

  const hubspot = getHubSpotClient();
  const chunkSize = 100;

  for (let index = 0; index < fromIds.length; index += chunkSize) {
    const chunk = fromIds.slice(index, index + chunkSize);
    const response = await scheduleHubSpotRequest(
      () =>
        hubspot.crm.associations.v4.batchApi.getPage(fromType, toType, {
          inputs: chunk.map((id) => ({ id })),
        }),
      `assoc.batch.getPage:${fromType}->${toType}`,
    );

    for (const row of response.results ?? []) {
      const fromId = row._from?.id;
      if (!fromId) {
        continue;
      }

      result.set(
        fromId,
        (row.to ?? []).map((target) => ({
          toObjectId: String(target.toObjectId),
          associationTypes: (target.associationTypes ?? []).map((spec) => ({
            typeId: spec.typeId,
            label: spec.label ?? null,
            category: spec.category,
          })),
        })),
      );
    }
  }

  return result;
}

export function formatAssociationLabels(
  types: AssociationSpec[],
  schema: AssociationSchemaEntry[],
): string[] {
  const schemaByTypeId = new Map(schema.map((entry) => [entry.typeId, entry.displayLabel]));
  const labels = new Set<string>();

  for (const spec of types) {
    labels.add(schemaByTypeId.get(spec.typeId) ?? resolveDisplayLabel(spec));
  }

  return [...labels];
}

export function isPrimaryCompanyAssociation(types: AssociationSpec[]): boolean {
  return types.some(
    (spec) => spec.typeId === 5 || spec.label?.toLowerCase() === "primary",
  );
}

export function sortAssociationEdges(edges: AssociationEdge[]): AssociationEdge[] {
  return [...edges].sort((left, right) => {
    const leftPrimary = isPrimaryCompanyAssociation(left.associationTypes) ? 0 : 1;
    const rightPrimary = isPrimaryCompanyAssociation(right.associationTypes) ? 0 : 1;
    if (leftPrimary !== rightPrimary) {
      return leftPrimary - rightPrimary;
    }
    return left.toObjectId.localeCompare(right.toObjectId);
  });
}

export async function enrichEdgesWithLabels(
  fromType: string,
  toType: string,
  edges: AssociationEdge[],
): Promise<Array<AssociationEdge & { labels: string[] }>> {
  const schema = await getAssociationSchema(fromType, toType);
  return edges.map((edge) => ({
    ...edge,
    labels: formatAssociationLabels(edge.associationTypes, schema),
  }));
}
