import {
  batchGetAssociations,
  formatAssociationLabels,
  getAssociatedIds,
  getAssociationSchema,
  getOwnerName,
  batchReadObjects,
} from "./client.js";
import {
  ACTIVITY_TYPES,
  type ActivityType,
  type NormalizedActivity,
} from "./types.js";

const ACTIVITY_PROPERTIES: Record<ActivityType, string[]> = {
  notes: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
  tasks: [
    "hs_task_subject",
    "hs_task_body",
    "hs_task_status",
    "hs_timestamp",
    "hubspot_owner_id",
  ],
  calls: [
    "hs_call_title",
    "hs_call_body",
    "hs_call_duration",
    "hs_timestamp",
    "hubspot_owner_id",
  ],
  emails: [
    "hs_email_subject",
    "hs_email_text",
    "hs_email_direction",
    "hs_timestamp",
    "hubspot_owner_id",
  ],
  meetings: [
    "hs_meeting_title",
    "hs_meeting_body",
    "hs_meeting_start_time",
    "hs_timestamp",
    "hubspot_owner_id",
  ],
};

export async function getDealActivities(
  dealId: string,
  options?: {
    types?: ActivityType[];
    since?: string;
    limit?: number;
    includeBody?: boolean;
  },
): Promise<NormalizedActivity[]> {
  const types = options?.types ?? [...ACTIVITY_TYPES];
  const includeBody = options?.includeBody ?? true;
  const limit = options?.limit ?? 100;
  const sinceMs = options?.since ? Date.parse(options.since) : null;

  const activities: NormalizedActivity[] = [];
  const activityIdsByType = new Map<ActivityType, string[]>();

  for (const type of types) {
    try {
      const ids = await getAssociatedIds("deals", dealId, type);
      activityIdsByType.set(type, ids);
      if (ids.length === 0) {
        continue;
      }

      const records = await batchReadObjects(type, ids, ACTIVITY_PROPERTIES[type]);
      for (const record of records) {
        const normalized = await normalizeActivity(type, record, includeBody);
        if (sinceMs !== null) {
          const activityMs = normalized.timestamp
            ? Date.parse(normalized.timestamp)
            : Number.NaN;
          if (!Number.isNaN(activityMs) && activityMs < sinceMs) {
            continue;
          }
        }
        activities.push(normalized);
      }
    } catch (error) {
      activities.push({
        id: `missing-scope-${type}`,
        type,
        timestamp: null,
        subject: null,
        body: null,
        status: null,
        ownerId: null,
        ownerName: null,
        url: null,
        associatedContactIds: [],
        associatedContactLabels: {},
        error:
          error instanceof Error
            ? error.message
            : `Failed to read ${type} activities`,
      });
    }
  }

  await attachActivityContactAssociations(activities, activityIdsByType);

  activities.sort((left, right) => {
    const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
    const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
    return rightTime - leftTime;
  });

  return activities.slice(0, limit);
}

async function attachActivityContactAssociations(
  activities: NormalizedActivity[],
  activityIdsByType: Map<ActivityType, string[]>,
): Promise<void> {
  for (const type of ACTIVITY_TYPES) {
    const ids = activityIdsByType.get(type) ?? [];
    if (ids.length === 0) {
      continue;
    }

    const [batch, schema] = await Promise.all([
      batchGetAssociations(type, ids, "contacts"),
      getAssociationSchema(type, "contacts"),
    ]);

    for (const activity of activities) {
      if (activity.type !== type || activity.error) {
        continue;
      }

      const edges = batch.get(activity.id) ?? [];
      activity.associatedContactIds = edges.map((edge) => edge.toObjectId);
      activity.associatedContactLabels = Object.fromEntries(
        edges.map((edge) => [
          edge.toObjectId,
          formatAssociationLabels(edge.associationTypes, schema),
        ]),
      );
    }
  }
}

async function normalizeActivity(
  type: ActivityType,
  record: { id: string; properties: Record<string, string | null | undefined>; url?: string },
  includeBody: boolean,
): Promise<NormalizedActivity> {
  const properties = record.properties;
  const ownerId = properties.hubspot_owner_id ?? null;
  const ownerName = await getOwnerName(ownerId);

  switch (type) {
    case "notes":
      return {
        id: record.id,
        type,
        timestamp: properties.hs_timestamp ?? null,
        subject: summarizeText(properties.hs_note_body, 80) ?? "Note",
        body: includeBody ? cleanText(properties.hs_note_body) : null,
        status: null,
        ownerId,
        ownerName,
        url: record.url ?? null,
        associatedContactIds: [],
        associatedContactLabels: {},
      };
    case "tasks":
      return {
        id: record.id,
        type,
        timestamp: properties.hs_timestamp ?? null,
        subject: properties.hs_task_subject ?? "Task",
        body: includeBody ? cleanText(properties.hs_task_body) : null,
        status: properties.hs_task_status ?? null,
        ownerId,
        ownerName,
        url: record.url ?? null,
        associatedContactIds: [],
        associatedContactLabels: {},
      };
    case "calls":
      return {
        id: record.id,
        type,
        timestamp: properties.hs_timestamp ?? null,
        subject: properties.hs_call_title ?? "Call",
        body: includeBody ? cleanText(properties.hs_call_body) : null,
        status: properties.hs_call_duration ?? null,
        ownerId,
        ownerName,
        url: record.url ?? null,
        associatedContactIds: [],
        associatedContactLabels: {},
      };
    case "emails":
      return {
        id: record.id,
        type,
        timestamp: properties.hs_timestamp ?? null,
        subject: properties.hs_email_subject ?? "Email",
        body: includeBody ? cleanText(properties.hs_email_text) : null,
        status: null,
        ownerId,
        ownerName,
        url: record.url ?? null,
        associatedContactIds: [],
        associatedContactLabels: {},
      };
    case "meetings":
      return {
        id: record.id,
        type,
        timestamp:
          properties.hs_meeting_start_time ?? properties.hs_timestamp ?? null,
        subject: properties.hs_meeting_title ?? "Meeting",
        body: includeBody ? cleanText(properties.hs_meeting_body) : null,
        status: null,
        ownerId,
        ownerName,
        url: record.url ?? null,
        associatedContactIds: [],
        associatedContactLabels: {},
      };
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported activity type: ${exhaustive}`);
    }
  }
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeText(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const firstLine = cleaned.split("\n").find((line) => line.trim()) ?? cleaned;
  if (firstLine.length <= maxLength) {
    return firstLine;
  }

  return `${firstLine.slice(0, maxLength - 1)}…`;
}
