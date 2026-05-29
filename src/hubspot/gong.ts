import type { ClassifiedActivity } from "./engagements.js";

export type ManifestObjectRef = {
  type: string;
  id: string;
};

export type ManifestEdge = {
  from: ManifestObjectRef;
  to: ManifestObjectRef;
  labels: string[];
};

export type GongCallRef = {
  id: string;
  meeting_id: string;
  placeholder: boolean;
};

const GONG_ID_IN_SUBJECT = /\[Gong\][^\d]*(\d{10,})/i;
const GONG_ID_GENERIC = /\b(\d{15,})\b/;

export function inferGongCallIdFromMeeting(activity: ClassifiedActivity): string | null {
  const subject = activity.subject ?? "";
  if (!/\[Gong\]/i.test(subject) && !/\[Gong\]/i.test(activity.body ?? "")) {
    return null;
  }

  const fromSubject = subject.match(GONG_ID_IN_SUBJECT);
  if (fromSubject?.[1]) {
    return fromSubject[1];
  }

  const fromBody = (activity.body ?? "").match(GONG_ID_GENERIC);
  if (fromBody?.[1]) {
    return fromBody[1];
  }

  return `placeholder-${activity.id}`;
}

export function buildGongManifestEdges(
  meetings: ClassifiedActivity[],
  contactsByEmail: Map<string, string>,
): { edges: ManifestEdge[]; gongCalls: GongCallRef[] } {
  const edges: ManifestEdge[] = [];
  const gongCalls: GongCallRef[] = [];
  const seen = new Set<string>();

  for (const meeting of meetings) {
    const gongId = inferGongCallIdFromMeeting(meeting);
    if (!gongId || seen.has(gongId)) {
      continue;
    }
    seen.add(gongId);

    const placeholder = gongId.startsWith("placeholder-");
    gongCalls.push({
      id: gongId,
      meeting_id: meeting.id,
      placeholder,
    });

    edges.push({
      from: ref("meetings", meeting.id),
      to: ref("gong_call", gongId),
      labels: ["Gong recording"],
    });

    for (const contactId of meeting.associatedContactIds) {
      edges.push({
        from: ref("gong_call", gongId),
        to: ref("contact", contactId),
        labels: ["Participant"],
      });
    }

    for (const contactId of matchContactsByTimestamp(meeting, contactsByEmail)) {
      if (!meeting.associatedContactIds.includes(contactId)) {
        edges.push({
          from: ref("gong_call", gongId),
          to: ref("contact", contactId),
          labels: ["Participant (time match)"],
        });
      }
    }
  }

  return { edges, gongCalls };
}

/** Placeholder: ±15min participant match when Gong metadata is not in HubSpot. */
function matchContactsByTimestamp(
  _meeting: ClassifiedActivity,
  _contactsByEmail: Map<string, string>,
): string[] {
  return [];
}

function ref(type: string, id: string): ManifestObjectRef {
  return { type, id };
}

export function parseMeetingTimestampMs(timestamp: string | null): number | null {
  if (!timestamp) {
    return null;
  }
  const ms = new Date(timestamp).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function isWithinMinutes(
  aMs: number | null,
  bMs: number | null,
  minutes: number,
): boolean {
  if (aMs === null || bMs === null) {
    return false;
  }
  return Math.abs(aMs - bMs) <= minutes * 60 * 1000;
}
