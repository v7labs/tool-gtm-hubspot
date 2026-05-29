import type { AssociationSpec } from "./associations.js";

export const ACTIVITY_TYPES = [
  "notes",
  "tasks",
  "calls",
  "emails",
  "meetings",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type HubSpotRecord = {
  id: string;
  properties: Record<string, string | null | undefined>;
  url?: string;
};

export type AssociatedRecord = HubSpotRecord & {
  associationTypes: AssociationSpec[];
  associationLabels: string[];
  isPrimary?: boolean;
};

export type NormalizedActivity = {
  id: string;
  type: ActivityType;
  timestamp: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  ownerId: string | null;
  ownerName: string | null;
  url: string | null;
  /** HubSpot association edges activity → contact */
  associatedContactIds: string[];
  associatedContactLabels: Record<string, string[]>;
  error?: string;
};

export type DealGraph = {
  deal: HubSpotRecord;
  companies: AssociatedRecord[];
  contacts: AssociatedRecord[];
  activities: NormalizedActivity[];
};
