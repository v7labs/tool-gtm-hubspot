import type { HubSpotRecord } from "./types.js";

import { Client } from "@hubspot/api-client";

import { getHubSpotAccessToken } from "../config.js";
import { scheduleHubSpotRequest } from "./rate-limiter.js";

export {
  getAssociatedIds,
  getAssociations,
  batchGetAssociations,
  getAssociationSchema,
  formatAssociationLabels,
} from "./associations.js";

let client: Client | null = null;

export function getHubSpotClient(): Client {
  if (!client) {
    // numberOfApiCallRetries enables the SDK's built-in backoff/retry on 429
    // (rate limit) and 5xx — important for bulk sync and paginated search,
    // which fan out many calls. Max supported by the SDK is 6.
    client = new Client({
      accessToken: getHubSpotAccessToken(),
      numberOfApiCallRetries: 3,
    });
  }

  return client;
}

export async function batchReadObjects(
  objectType: ActivityObjectType | "companies" | "contacts" | "deals",
  ids: string[],
  properties: string[],
): Promise<HubSpotRecord[]> {
  if (ids.length === 0) {
    return [];
  }

  const hubspot = getHubSpotClient();

  const readChunk = (inputs: Array<{ id: string }>) => {
    const payload = {
      properties,
      propertiesWithHistory: [],
      inputs,
    };

    switch (objectType) {
      case "deals":
        return hubspot.crm.deals.batchApi.read(payload);
      case "companies":
        return hubspot.crm.companies.batchApi.read(payload);
      case "contacts":
        return hubspot.crm.contacts.batchApi.read(payload);
      case "notes":
        return hubspot.crm.objects.notes.batchApi.read(payload);
      case "tasks":
        return hubspot.crm.objects.tasks.batchApi.read(payload);
      case "calls":
        return hubspot.crm.objects.calls.batchApi.read(payload);
      case "emails":
        return hubspot.crm.objects.emails.batchApi.read(payload);
      case "meetings":
        return hubspot.crm.objects.meetings.batchApi.read(payload);
      default: {
        const exhaustive: never = objectType;
        throw new Error(`Unsupported object type: ${exhaustive}`);
      }
    }
  };

  // HubSpot's batchApi.read caps at 100 ids per request (HTTP 400 above that),
  // so chunk the inputs and concatenate — mirrors batchGetAssociations in
  // associations.ts. Callers (e.g. manifest.ts) may pass far more than 100 ids.
  const chunkSize = 100;
  const records: HubSpotRecord[] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    const inputs = ids.slice(index, index + chunkSize).map((id) => ({ id }));
    const response = await scheduleHubSpotRequest(() => readChunk(inputs));
    records.push(...(response.results ?? []).map(toHubSpotRecord));
  }

  return records;
}

export type ActivityObjectType =
  | "notes"
  | "tasks"
  | "calls"
  | "emails"
  | "meetings";

type SimplePublicObject = {
  id: string;
  properties?: Record<string, string | null>;
  url?: string;
};

function toHubSpotRecord(object: SimplePublicObject): HubSpotRecord {
  return {
    id: object.id,
    properties: object.properties ?? {},
    url: object.url,
  };
}

// Owner id → resolved display name. Owner names are stable within (and across)
// a sync, but getOwnerName is called once per activity, so without this memo a
// 94-activity deal fires ~94 identical owner lookups — a major amplifier of the
// per-10s burst the throttler is fighting. Collapses to one call per distinct
// owner. Module-scoped to mirror the existing schema/pipeline caches; only
// SUCCESSFUL resolutions are cached so a transient (e.g. 429) failure is retried
// rather than poisoning the cache with a spurious null.
const ownerNameCache = new Map<string, string | null>();

export async function getOwnerName(ownerId: string | null | undefined): Promise<string | null> {
  if (!ownerId) {
    return null;
  }

  if (ownerNameCache.has(ownerId)) {
    return ownerNameCache.get(ownerId) ?? null;
  }

  try {
    const hubspot = getHubSpotClient();
    const owner = await scheduleHubSpotRequest(() =>
      hubspot.crm.owners.ownersApi.getById(Number(ownerId)),
    );
    const first = owner.firstName ?? "";
    const last = owner.lastName ?? "";
    const full = `${first} ${last}`.trim();
    const resolved = full || owner.email || null;
    ownerNameCache.set(ownerId, resolved);
    return resolved;
  } catch {
    return null;
  }
}
