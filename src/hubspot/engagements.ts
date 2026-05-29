import type { ActivityType, NormalizedActivity } from "./types.js";

export type EngagementClass = "substantive" | "calendar" | "duplicate";

export type ClassifiedActivity = NormalizedActivity & {
  engagementClass: EngagementClass;
  alsoHubspotIds?: string[];
  emailDirection?: string | null;
};

const CALENDAR_SUBJECT =
  /^(Accepted:|Declined:|Tentatively Accepted:)/i;

const CALENDAR_REMINDER = /^Our meeting in \d+ minutes/i;

export function classifyEngagement(activity: NormalizedActivity): EngagementClass {
  if (activity.type === "emails") {
    const subject = activity.subject ?? "";
    if (CALENDAR_SUBJECT.test(subject) || CALENDAR_REMINDER.test(subject)) {
      return "calendar";
    }
  }
  return "substantive";
}

export function dedupeMeetings(
  activities: ClassifiedActivity[],
): ClassifiedActivity[] {
  const nonMeetings = activities.filter((item) => item.type !== "meetings");
  const meetings = activities.filter((item) => item.type === "meetings");

  const byTime = new Map<string, ClassifiedActivity[]>();
  for (const meeting of meetings) {
    const key = meeting.timestamp ?? meeting.id;
    const group = byTime.get(key) ?? [];
    group.push(meeting);
    byTime.set(key, group);
  }

  const dedupedMeetings: ClassifiedActivity[] = [];
  for (const group of byTime.values()) {
    if (group.length === 1) {
      dedupedMeetings.push(group[0]);
      continue;
    }

    const preferred =
      group.find((item) => !(item.subject ?? "").includes("[Gong]")) ?? group[0];
    const alsoIds = group.filter((item) => item.id !== preferred.id).map((item) => item.id);
    dedupedMeetings.push({
      ...preferred,
      engagementClass: "substantive",
      alsoHubspotIds: alsoIds.length > 0 ? alsoIds : undefined,
    });
  }

  return [...nonMeetings, ...dedupedMeetings];
}

export function classifyActivities(
  activities: NormalizedActivity[],
): ClassifiedActivity[] {
  const classified = activities
    .filter((item) => !item.error && !item.id.startsWith("missing-scope-"))
    .map((item) => ({
      ...item,
      engagementClass: classifyEngagement(item),
    }));

  return dedupeMeetings(classified);
}

export function substantiveActivities(
  activities: ClassifiedActivity[],
): ClassifiedActivity[] {
  return activities.filter((item) => item.engagementClass === "substantive");
}

export function calendarActivities(
  activities: ClassifiedActivity[],
): ClassifiedActivity[] {
  return activities.filter((item) => item.engagementClass === "calendar");
}

export function activityTypeLabel(type: ActivityType): string {
  return type.replace(/s$/, "");
}
