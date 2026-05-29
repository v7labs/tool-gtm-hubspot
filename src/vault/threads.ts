import type { HubSpotRecord, NormalizedActivity } from "../hubspot/types.js";
import {
  extractLatestEmailContent,
  emailThreadKey,
  oneLineSummary,
  activityInvolvesContact,
  type ActivityPathEntry,
} from "./timeline.js";
import { formatDatePrefix, noteTitleFromPath, sanitizeFilename } from "./writer.js";

export type EmailThreadMessage = {
  activity: NormalizedActivity;
  index: number;
  excerpt: string;
  greeting: string | null;
  signer: string | null;
  occurredAt: string | null;
};

export type EmailThreadGroup = {
  threadKey: string;
  displaySubject: string;
  messages: EmailThreadMessage[];
  startedAt: string | null;
  latestAt: string | null;
};

export type DealTimelineEntry =
  | {
      kind: "activity";
      title: string;
      path: string;
      activity: NormalizedActivity;
      summary: string;
      timestamp: string | null;
    }
  | {
      kind: "thread";
      title: string;
      path: string;
      thread: EmailThreadGroup;
      summary: string;
      timestamp: string | null;
    };

export function groupEmailThreads(
  entries: ActivityPathEntry[],
): Map<string, ActivityPathEntry[]> {
  const groups = new Map<string, ActivityPathEntry[]>();

  for (const entry of entries) {
    if (entry.activity.type !== "emails") {
      continue;
    }

    const key = emailThreadKey(entry.activity.subject);
    if (!key) {
      continue;
    }

    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  return groups;
}

export function buildEmailThreadGroup(
  threadKey: string,
  entries: ActivityPathEntry[],
): EmailThreadGroup {
  const sorted = [...entries].sort((left, right) => {
    const leftTime = left.activity.timestamp ? Date.parse(left.activity.timestamp) : 0;
    const rightTime = right.activity.timestamp ? Date.parse(right.activity.timestamp) : 0;
    return leftTime - rightTime;
  });

  const displaySubject =
    sorted[0]?.activity.subject?.replace(/^(re:\s*)+/i, "").trim() ?? threadKey;

  const messages: EmailThreadMessage[] = sorted.map((entry, index) => ({
    activity: entry.activity,
    index: index + 1,
    excerpt: extractLatestEmailContent(entry.activity.body) ?? oneLineSummary(entry.activity),
    greeting: parseEmailGreeting(entry.activity.body),
    signer: parseEmailSignature(entry.activity.body),
    occurredAt: entry.activity.timestamp,
  }));

  return {
    threadKey,
    displaySubject,
    messages,
    startedAt: messages[0]?.occurredAt ?? null,
    latestAt: messages[messages.length - 1]?.occurredAt ?? null,
  };
}

export function threadSyntheticHubspotId(dealId: string, threadKey: string): string {
  const slug = threadKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `thread-${dealId}-${slug}`;
}

export function threadRelativePath(
  thread: EmailThreadGroup,
  usedPaths: Set<string>,
  dealFolder: string,
): string {
  const date = formatDatePrefix(thread.startedAt);
  const subject = sanitizeFilename(thread.displaySubject);
  const base = `${date} thread — ${subject}`;
  let candidate = `${dealFolder}/threads/${base}.md`;
  let suffix = 2;

  while (usedPaths.has(candidate)) {
    candidate = `${dealFolder}/threads/${base} (${suffix}).md`;
    suffix += 1;
  }

  usedPaths.add(candidate);
  return candidate;
}

export function buildDealTimeline(
  entries: ActivityPathEntry[],
  usedPaths: Set<string>,
  dealFolder: string,
): {
  timeline: DealTimelineEntry[];
  mergedEmailIds: string[];
  threadGroups: EmailThreadGroup[];
} {
  const threadMap = groupEmailThreads(entries);
  const mergedEmailIds: string[] = [];
  const threadGroups: EmailThreadGroup[] = [];
  const consumedThreadKeys = new Set<string>();
  const threadTimelineEntries: DealTimelineEntry[] = [];

  for (const [threadKey, threadEntries] of threadMap) {
    if (threadEntries.length < 2) {
      continue;
    }

    const thread = buildEmailThreadGroup(threadKey, threadEntries);
    const path = threadRelativePath(thread, usedPaths, dealFolder);
    const title = noteTitleFromPath(path);

    threadGroups.push(thread);
    consumedThreadKeys.add(threadKey);

    for (const entry of threadEntries) {
      mergedEmailIds.push(entry.activity.id);
    }

    threadTimelineEntries.push({
      kind: "thread",
      title,
      path,
      thread,
      summary: summarizeThread(thread),
      timestamp: thread.startedAt,
    });
  }

  const timeline: DealTimelineEntry[] = [];

  for (const entry of entries) {
    if (entry.activity.type === "emails") {
      const key = emailThreadKey(entry.activity.subject);
      if (key && consumedThreadKeys.has(key)) {
        continue;
      }
    }

    timeline.push({
      kind: "activity",
      title: entry.title,
      path: entry.path,
      activity: entry.activity,
      summary: oneLineSummary(entry.activity),
      timestamp: entry.activity.timestamp,
    });
  }

  timeline.push(...threadTimelineEntries);

  timeline.sort((left, right) => {
    const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
    const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
    return leftTime - rightTime;
  });

  return { timeline, mergedEmailIds, threadGroups };
}

export function summarizeThread(thread: EmailThreadGroup): string {
  if (thread.messages.length === 0) {
    return thread.displaySubject;
  }

  const first = thread.messages[0];
  const last = thread.messages[thread.messages.length - 1];
  const firstLine = first.excerpt.split("\n").find((line) => line.trim())?.trim() ?? "";
  const lastLine = last.excerpt.split("\n").find((line) => line.trim())?.trim() ?? "";

  if (thread.messages.length === 1) {
    return lastLine.slice(0, 160);
  }

  return `${thread.messages.length} messages: ${firstLine.slice(0, 72)}… → ${lastLine.slice(0, 72)}…`;
}

export function parseEmailGreeting(body: string | null): string | null {
  const content = extractLatestEmailContent(body);
  if (!content) {
    return null;
  }

  const hiMatch = content.match(/^hi\s+([^,\n]+)/im);
  if (hiMatch) {
    return hiMatch[1].trim();
  }

  const helloMatch = content.match(/^hello\s+([^,\n]+)/im);
  if (helloMatch) {
    return helloMatch[1].trim();
  }

  return null;
}

export function parseEmailSignature(body: string | null): string | null {
  const content = extractLatestEmailContent(body);
  if (!content) {
    return null;
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (/^(kind regards|regards|thanks|thank you),?\.?$/i.test(lines[index])) {
      const signer = lines[index + 1];
      if (signer && signer.length < 80 && !signer.includes("@")) {
        return signer;
      }
    }
  }

  return null;
}

export function formatMessageDirection(message: EmailThreadMessage): string {
  const to = message.greeting ?? "recipient";
  const from = message.signer ?? "sender";
  return `${from} → ${to}`;
}

export function formatMessageTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return "undated";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "undated";
  }

  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;
}

export function renderThreadConversation(messages: EmailThreadMessage[]): string {
  return messages
    .map((message) => {
      const direction = formatMessageDirection(message);
      const when = formatMessageTimestamp(message.occurredAt);
      const excerpt = message.excerpt
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");

      const hubspotLink = message.activity.url
        ? `[HubSpot ${message.activity.id}](${message.activity.url})`
        : `HubSpot ${message.activity.id}`;

      return `### ${message.index} · ${when} · ${direction}

${excerpt}

_${hubspotLink}_`;
    })
    .join("\n\n");
}

export function threadInvolvesContact(
  thread: EmailThreadGroup,
  contact: HubSpotRecord,
): boolean {
  return thread.messages.some((message) =>
    activityInvolvesContact(contact, message.activity),
  );
}

export function buildTimelineFlowLines(timeline: DealTimelineEntry[]): string[] {
  return timeline.map((entry, index) => {
    const date = formatDatePrefix(entry.timestamp);
    const label = entry.kind === "thread" ? "email thread" : activityTypeLabel(entry.activity.type);
    return `${index + 1}. ${date} · **${label}** · [[${entry.title}]] — ${entry.summary}`;
  });
}

export function buildTimelineTableRows(timeline: DealTimelineEntry[]): string[] {
  return timeline.map((entry) => {
    const date = formatDatePrefix(entry.timestamp);
    const label = entry.kind === "thread" ? "thread" : activityTypeLabel(entry.activity.type);
    return `| ${date} | ${label} | [[${entry.title}]] | ${entry.summary.replace(/\|/g, "\\|")} |`;
  });
}

function activityTypeLabel(type: NormalizedActivity["type"]): string {
  return type.replace(/s$/, "");
}

export function buildTimelineNarrative(
  timeline: DealTimelineEntry[],
  companyName: string,
  contactNames: string[],
): string {
  if (timeline.length === 0) {
    return "_No activity history to summarize._";
  }

  const bullets: string[] = [
    `- **Account context:** ${companyName}${contactNames.length > 0 ? ` with ${contactNames.join(", ")}` : ""}.`,
  ];

  for (const entry of timeline) {
    const date = formatDatePrefix(entry.timestamp);
    const label = entry.kind === "thread" ? "email thread" : activityTypeLabel(entry.activity.type);
    bullets.push(`- **${date}** (${label}): ${entry.summary}`);
  }

  const last = timeline[timeline.length - 1];
  const lastDate =
    last.kind === "thread"
      ? formatDatePrefix(last.thread.latestAt)
      : formatDatePrefix(last.timestamp);
  bullets.push(`- **Latest signal:** ${lastDate} — ${last.summary}`);

  return bullets.join("\n");
}
