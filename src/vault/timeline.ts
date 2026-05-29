import type { HubSpotRecord, NormalizedActivity } from "../hubspot/types.js";
import { getContactName } from "../hubspot/deals.js";
import { formatDatePrefix, noteTitleFromPath, sanitizeFilename } from "./writer.js";

export type ActivityPathEntry = {
  activity: NormalizedActivity;
  path: string;
  title: string;
};

export function sortActivitiesChronological(
  activities: NormalizedActivity[],
): NormalizedActivity[] {
  return [...activities].sort((left, right) => {
    const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
    const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
    return leftTime - rightTime;
  });
}

export function activityRelativePath(
  activity: NormalizedActivity,
  usedPaths: Set<string>,
  dealFolder: string,
): string {
  const date = formatDatePrefix(activity.timestamp);
  const typeLabel = activity.type.replace(/s$/, "");
  const subject = sanitizeFilename(activity.subject ?? typeLabel);
  const base = `${date} ${typeLabel} — ${subject}`;
  let candidate = `${dealFolder}/activities/${base}.md`;
  let suffix = 2;

  while (usedPaths.has(candidate)) {
    candidate = `${dealFolder}/activities/${base} (${suffix}).md`;
    suffix += 1;
  }

  usedPaths.add(candidate);
  return candidate;
}

export function emailThreadKey(subject: string | null): string | null {
  if (!subject) {
    return null;
  }

  const normalized = subject.replace(/^(re:\s*)+/i, "").trim();
  return normalized.length > 0 ? normalized.toLowerCase() : null;
}

export function extractLatestEmailContent(body: string | null): string | null {
  if (!body) {
    return null;
  }

  const lines = body.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on .+ wrote:$/i.test(trimmed)) {
      break;
    }
    if (trimmed.startsWith(">")) {
      break;
    }
    if (trimmed === "--" || trimmed === "—") {
      break;
    }
    kept.push(line);
  }

  const latest = kept.join("\n").trim();
  return latest.length > 0 ? latest : body.trim();
}

export function oneLineSummary(activity: NormalizedActivity): string {
  const subject = activity.subject?.trim();
  if (subject) {
    return subject;
  }

  const body = activity.body?.split("\n").find((line) => line.trim());
  if (body) {
    return body.trim().slice(0, 120);
  }

  return activity.type;
}

export function activityTypeLabel(type: NormalizedActivity["type"]): string {
  return type.replace(/s$/, "");
}

export function activityInvolvesContact(
  contact: HubSpotRecord,
  activity: NormalizedActivity,
): boolean {
  if (activity.associatedContactIds.includes(contact.id)) {
    return true;
  }

  return contactMentionedInActivity(contact, activity);
}

export function contactMentionedInActivity(
  contact: HubSpotRecord,
  activity: NormalizedActivity,
): boolean {
  const haystack = `${activity.subject ?? ""}\n${activity.body ?? ""}`.toLowerCase();
  const email = contact.properties.email?.trim().toLowerCase();
  const name = getContactName(contact).toLowerCase();

  if (email && haystack.includes(email)) {
    return true;
  }

  if (name.length > 2 && haystack.includes(name)) {
    return true;
  }

  const first = contact.properties.firstname?.trim().toLowerCase();
  return Boolean(first && first.length > 2 && haystack.includes(first));
}

export function buildFlowLines(entries: ActivityPathEntry[]): string[] {
  return entries.map((entry, index) => {
    const date = formatDatePrefix(entry.activity.timestamp);
    const type = activityTypeLabel(entry.activity.type);
    const summary = oneLineSummary(entry.activity);
    return `${index + 1}. ${date} · **${type}** · [[${entry.title}]] — ${summary}`;
  });
}

export function buildThreadSections(entries: ActivityPathEntry[]): string {
  const byThread = new Map<string, ActivityPathEntry[]>();

  for (const entry of entries) {
    if (entry.activity.type !== "emails") {
      continue;
    }

    const key = emailThreadKey(entry.activity.subject) ?? entry.title;
    const group = byThread.get(key) ?? [];
    group.push(entry);
    byThread.set(key, group);
  }

  if (byThread.size === 0) {
    return "_No email threads._";
  }

  const sections: string[] = [];
  for (const [thread, threadEntries] of byThread) {
    const displaySubject =
      threadEntries[0]?.activity.subject?.replace(/^(re:\s*)+/i, "") ?? thread;
    const chain = threadEntries
      .map((entry) => `[[${entry.title}]]`)
      .join(" → ");
    sections.push(`### ${displaySubject}\n\n${chain} (${threadEntries.length} messages)`);
  }

  return sections.join("\n\n");
}

export function buildActivityTableRows(entries: ActivityPathEntry[]): string[] {
  return entries.map((entry) => {
    const date = formatDatePrefix(entry.activity.timestamp);
    const type = activityTypeLabel(entry.activity.type);
    return `| ${date} | ${type} | [[${entry.title}]] | ${oneLineSummary(entry.activity).replace(/\|/g, "\\|")} |`;
  });
}

export function titlesFromPaths(paths: string[]): string[] {
  return paths.map((path) => noteTitleFromPath(path));
}
